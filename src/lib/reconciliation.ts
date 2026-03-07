import {
  cleanupOldRelayTranslationJobs,
  cleanupOldTranscriptionJobs,
  completeTranslationJobWithSettlement,
  failTranslationJobWithReservationRelease,
  listTranscriptionJobsForReconciliation,
  listTranslationJobsForReconciliation,
  releaseBillingReservation,
  resetTranslationJobRelay,
  storeTranscriptionJobError,
  type TranslationJobRecord,
} from "./db";
import { API_ERRORS } from "./constants";
import { isAllowedTranslationModel, normalizeTranslationModel } from "./pricing";
import { estimateTranslationReservationCredits } from "./relay-billing";
import { buildR2TranscriptionReservationKey } from "./transcription-billing";
import { buildTranslationReservationKey } from "./translation-idempotency";

export interface ReconciliationOptions {
  dryRun?: boolean;
  limit?: number;
  translationStaleMinutes?: number;
  transcriptionPendingUploadStaleMinutes?: number;
  transcriptionProcessingStaleMinutes?: number;
  cleanupMaxAgeHours?: number;
}

export interface ReconciliationReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  dryRun: boolean;
  options: Required<ReconciliationOptions>;
  translation: {
    scanned: number;
    staleRelayReset: number;
    wouldResetRelay: number;
    rebilled: number;
    wouldRebill: number;
    markedFailed: number;
    insufficientCredits: number;
    skipped: number;
    errors: string[];
  };
  transcription: {
    scanned: number;
    markedFailed: number;
    wouldMarkFailed: number;
    skipped: number;
    errors: string[];
  };
  cleanup: {
    transcriptionJobsDeleted: number;
    relayTranslationJobsDeleted: number;
  };
}

const MAX_REPORTED_ERRORS = 25;

function addReportError(target: string[], message: string): void {
  if (target.length >= MAX_REPORTED_ERRORS) return;
  target.push(message);
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function estimatePromptTokens(payload: Record<string, unknown> | null): number {
  try {
    const raw = JSON.stringify(payload?.messages ?? payload ?? {});
    return Math.ceil(raw.length / 4);
  } catch {
    return 0;
  }
}

function estimateCompletionTokens(result: Record<string, unknown> | null): number {
  try {
    const usage = result?.usage as any;
    if (typeof usage?.completion_tokens === "number") {
      return usage.completion_tokens;
    }
    const content = (result as any)?.choices?.[0]?.message?.content ?? "";
    return Math.ceil(String(content).length / 4);
  } catch {
    return 0;
  }
}

function resolveBillingModel(job: TranslationJobRecord): string | null {
  const parsedResult = parseJsonObject(job.result);
  const parsedPayload = parseJsonObject(job.payload);

  const completionModel =
    typeof parsedResult?.model === "string" ? parsedResult.model.trim() : "";
  if (completionModel) return completionModel;

  const payloadModel =
    typeof parsedPayload?.model === "string" ? parsedPayload.model.trim() : "";
  if (payloadModel) return payloadModel;

  const storedModel = typeof job.model === "string" ? job.model.trim() : "";
  return storedModel || null;
}

function resolvePromptTokens(job: TranslationJobRecord): number {
  if (typeof job.prompt_tokens === "number" && Number.isFinite(job.prompt_tokens)) {
    return job.prompt_tokens;
  }
  return estimatePromptTokens(parseJsonObject(job.payload));
}

function resolveCompletionTokens(job: TranslationJobRecord): number {
  if (
    typeof job.completion_tokens === "number" &&
    Number.isFinite(job.completion_tokens)
  ) {
    return job.completion_tokens;
  }
  return estimateCompletionTokens(parseJsonObject(job.result));
}

function buildDefaultOptions(
  options?: ReconciliationOptions
): Required<ReconciliationOptions> {
  return {
    dryRun: options?.dryRun === true,
    limit: Math.max(1, Math.floor(options?.limit ?? 200)),
    translationStaleMinutes: Math.max(
      1,
      Math.floor(options?.translationStaleMinutes ?? 30)
    ),
    transcriptionPendingUploadStaleMinutes: Math.max(
      1,
      Math.floor(options?.transcriptionPendingUploadStaleMinutes ?? 120)
    ),
    transcriptionProcessingStaleMinutes: Math.max(
      1,
      Math.floor(options?.transcriptionProcessingStaleMinutes ?? 60)
    ),
    cleanupMaxAgeHours: Math.max(1, Math.floor(options?.cleanupMaxAgeHours ?? 48)),
  };
}

async function failTranslationJobDuringReconciliation({
  job,
  message,
}: {
  job: TranslationJobRecord;
  message: string;
}): Promise<void> {
  const result = await failTranslationJobWithReservationRelease({
    jobId: job.job_id,
    deviceId: job.device_id,
    requestKey: buildTranslationReservationKey(job.job_id),
    message,
    reason: "TRANSLATE",
    billingMeta: {
      source: "reconciliation",
      jobId: job.job_id,
      deviceId: job.device_id,
    },
  });
  if (!result.ok) {
    throw new Error(`failed to mark translation job failed: ${result.error}`);
  }
}

export async function runReconciliation(
  options?: ReconciliationOptions
): Promise<ReconciliationReport> {
  const startMs = Date.now();
  const cfg = buildDefaultOptions(options);
  const report: ReconciliationReport = {
    startedAt: new Date(startMs).toISOString(),
    finishedAt: "",
    durationMs: 0,
    dryRun: cfg.dryRun,
    options: cfg,
    translation: {
      scanned: 0,
      staleRelayReset: 0,
      wouldResetRelay: 0,
      rebilled: 0,
      wouldRebill: 0,
      markedFailed: 0,
      insufficientCredits: 0,
      skipped: 0,
      errors: [],
    },
    transcription: {
      scanned: 0,
      markedFailed: 0,
      wouldMarkFailed: 0,
      skipped: 0,
      errors: [],
    },
    cleanup: {
      transcriptionJobsDeleted: 0,
      relayTranslationJobsDeleted: 0,
    },
  };

  const translationCandidates = await listTranslationJobsForReconciliation({
    staleMinutes: cfg.translationStaleMinutes,
    limit: cfg.limit,
  });

  report.translation.scanned = translationCandidates.length;
  for (const job of translationCandidates) {
    try {
      if (
        job.status === "queued" ||
        job.status === "processing" ||
        job.status === "dispatching"
      ) {
        if (cfg.dryRun) {
          report.translation.wouldResetRelay += 1;
        } else {
          await resetTranslationJobRelay({ jobId: job.job_id });
          report.translation.staleRelayReset += 1;
        }
        continue;
      }

      if (job.status !== "completed") {
        report.translation.skipped += 1;
        continue;
      }

      const credited =
        typeof job.credited === "number"
          ? job.credited
          : Number.parseInt(String(job.credited ?? 0), 10) || 0;

      if (credited > 0) {
        report.translation.skipped += 1;
        continue;
      }

      if (!job.result) {
        if (cfg.dryRun) {
          report.translation.markedFailed += 1;
        } else {
          await failTranslationJobDuringReconciliation({
            job,
            message: "reconcile:completed-without-result",
          });
          report.translation.markedFailed += 1;
        }
        continue;
      }

      const rawModel = resolveBillingModel(job);
      const normalizedModel = normalizeTranslationModel(rawModel || "");
      if (!rawModel || !isAllowedTranslationModel(normalizedModel)) {
        if (!cfg.dryRun) {
          await failTranslationJobDuringReconciliation({
            job,
            message: `reconcile:unsupported-billing-model:${normalizedModel || "missing"}`,
          });
        }
        report.translation.markedFailed += 1;
        continue;
      }

      const promptTokens = resolvePromptTokens(job);
      const completionTokens = resolveCompletionTokens(job);
      if (cfg.dryRun) {
        report.translation.wouldRebill += 1;
        continue;
      }

      const actualSpend = estimateTranslationReservationCredits({
        promptTokens,
        maxCompletionTokens: completionTokens,
        model: normalizedModel,
        webSearchCalls: 0,
      });
      // Queued translations now reserve upfront at creation time, so recovery
      // must settle or release that reservation instead of charging again.
      const completionResult = await completeTranslationJobWithSettlement({
        jobId: job.job_id,
        deviceId: job.device_id,
        requestKey: buildTranslationReservationKey(job.job_id),
        result: parseJsonObject(job.result) ?? {},
        promptTokens,
        completionTokens,
        actualSpend,
        reason: "TRANSLATE",
        billingMeta: {
          source: "reconciliation",
          jobId: job.job_id,
          model: normalizedModel,
          promptTokens,
          completionTokens,
          spend: actualSpend,
        },
      });

      if (!completionResult.ok) {
        await failTranslationJobDuringReconciliation({
          job,
          message:
            completionResult.error === "actual-spend-exceeds-reserve"
              ? API_ERRORS.INSUFFICIENT_CREDITS
              : completionResult.error,
        });
        if (completionResult.error === "actual-spend-exceeds-reserve") {
          report.translation.insufficientCredits += 1;
        } else {
          report.translation.markedFailed += 1;
        }
        continue;
      }

      report.translation.rebilled += 1;
    } catch (error: any) {
      addReportError(
        report.translation.errors,
        `${job.job_id}: ${error?.message || String(error)}`
      );
    }
  }

  const transcriptionCandidates = await listTranscriptionJobsForReconciliation({
    pendingUploadStaleMinutes: cfg.transcriptionPendingUploadStaleMinutes,
    processingStaleMinutes: cfg.transcriptionProcessingStaleMinutes,
    limit: cfg.limit,
  });

  report.transcription.scanned = transcriptionCandidates.length;
  for (const job of transcriptionCandidates) {
    try {
      let reason = "reconcile:job-inconsistent";
      if (job.status === "pending_upload") {
        reason = "reconcile:pending-upload-timeout";
      } else if (job.status === "processing") {
        reason = "reconcile:processing-timeout";
      } else if (job.status === "completed") {
        reason = "reconcile:completed-without-result";
      }

      if (cfg.dryRun) {
        report.transcription.wouldMarkFailed += 1;
      } else {
        const releaseResult = await releaseBillingReservation({
          deviceId: job.device_id,
          service: "transcription",
          requestKey: buildR2TranscriptionReservationKey(job.job_id),
          reason: "TRANSCRIBE",
          meta: {
            reason,
            source: "reconciliation",
            jobId: job.job_id,
          },
        });
        if (!releaseResult.ok && releaseResult.error !== "missing-reservation") {
          addReportError(
            report.transcription.errors,
            `${job.job_id}: failed to release stale reservation (${releaseResult.error})`
          );
        }

        await storeTranscriptionJobError({
          jobId: job.job_id,
          message: reason,
        });
        report.transcription.markedFailed += 1;
      }
    } catch (error: any) {
      addReportError(
        report.transcription.errors,
        `${job.job_id}: ${error?.message || String(error)}`
      );
    }
  }

  if (!cfg.dryRun) {
    try {
      report.cleanup.transcriptionJobsDeleted = await cleanupOldTranscriptionJobs({
        maxAgeHours: cfg.cleanupMaxAgeHours,
      });
    } catch (error: any) {
      addReportError(
        report.transcription.errors,
        `cleanup-transcription: ${error?.message || String(error)}`
      );
    }

    try {
      report.cleanup.relayTranslationJobsDeleted =
        await cleanupOldRelayTranslationJobs({
          maxAgeHours: cfg.cleanupMaxAgeHours,
        });
    } catch (error: any) {
      addReportError(
        report.translation.errors,
        `cleanup-relay-translation: ${error?.message || String(error)}`
      );
    }
  }

  const finishMs = Date.now();
  report.finishedAt = new Date(finishMs).toISOString();
  report.durationMs = finishMs - startMs;
  return report;
}

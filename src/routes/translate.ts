import { Hono, Context } from "hono";
import crypto from "node:crypto";
import { z } from "zod";
import { cors } from "hono/cors";
import { API_ERRORS, getProviderFromModel } from "../lib/constants";
import { isAllowedTranslationModel, normalizeTranslationModel } from "../lib/pricing";
import { resolveTranslationBillingIdempotencyKey } from "../lib/translation-idempotency";
import {
  createTranslationJob,
  claimTranslationJobDispatch,
  countQueuedTranslationJobs,
  countTranslationJobsInFlight,
  countActiveTranslationJobsForDevice,
  countRecentTranslationJobsForDevice,
  setTranslationJobProcessing,
  setTranslationJobQueuedWithRelay,
  listQueuedTranslationJobs,
  resetTranslationJobRelay,
  getTranslationJob,
  storeTranslationJobResult,
  storeTranslationJobError,
  markTranslationJobCredited,
  deductTranslationCredits,
  TranslationJobRecord,
} from "../lib/db";
import {
  submitTranslationRelayJob,
  fetchRelayTranslationStatus,
  RelayHttpError,
} from "../lib/openai-config";
import { bearerAuth, type AuthVariables } from "../lib/middleware";
import { emitAlert, incrementCounter, observeDuration } from "../lib/observability";
import { getRequestId, getRequestIdempotencyKey } from "../lib/request-utils";
import {
  type ErrorStatusCode,
  encodeTranslationJobError,
  isRelaySubmitTerminalStatus,
  mapRelaySubmitTerminalFailure,
  parseTranslationJobError,
} from "./translate/error-utils";
import {
  getRelayAdmissionConfig,
  getRelayAlertConfig,
  getRelayDispatchConfig,
} from "./translate/relay-config";
import type { Stage5ApiBindings } from "../types/env";

const router = new Hono<{
  Bindings: Stage5ApiBindings;
  Variables: AuthVariables;
}>();

router.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["POST", "GET", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "X-Idempotency-Key",
      "X-Request-Id",
    ],
  })
);

router.options(
  "*",
  (c) =>
    new Response("", {
      status: 204,
      headers: { "Content-Type": "text/plain" },
    })
);

// Use shared auth middleware
router.use("*", bearerAuth());

const translateSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["user", "system", "assistant"]),
      content: z.string(),
    })
  ),
  model: z.string().optional(),
  modelFamily: z.enum(["gpt", "claude", "auto"]).optional(),
  reasoning: z.any().optional(),
  translationPhase: z.enum(["draft", "review"]).optional(),
  qualityMode: z.boolean().optional(),
});

let consecutiveDispatchFailures = 0;
const MAX_RETRYABLE_RELAY_POLL_FAILURES = 6;
const MAX_RETRYABLE_RELAY_POLL_FAILURE_WINDOW_MS = 120_000;
const RELAY_ACCEPTED_PERSIST_MAX_ATTEMPTS = 4;
const RELAY_ACCEPTED_PERSIST_RETRY_DELAYS_MS = [120, 320, 900] as const;
const relayPollRetryState = new Map<
  string,
  {
    firstAtMs: number;
    lastAtMs: number;
    attempts: number;
  }
>();

class RelayAcceptedPersistenceError extends Error {
  readonly jobId: string;
  readonly relayJobId: string;
  readonly attempts: number;

  constructor({
    jobId,
    relayJobId,
    attempts,
    detail,
  }: {
    jobId: string;
    relayJobId: string;
    attempts: number;
    detail: string;
  }) {
    super(
      `Relay job accepted but failed to persist linkage for ${jobId} (relayJobId=${relayJobId}) after ${attempts} attempts: ${detail}`
    );
    this.name = "RelayAcceptedPersistenceError";
    this.jobId = jobId;
    this.relayJobId = relayJobId;
    this.attempts = attempts;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function persistAcceptedRelayLink({
  jobId,
  relayJobId,
  requestId,
}: {
  jobId: string;
  relayJobId: string;
  requestId?: string;
}): Promise<void> {
  let lastErrorMessage = "unknown error";
  for (let attempt = 1; attempt <= RELAY_ACCEPTED_PERSIST_MAX_ATTEMPTS; attempt += 1) {
    try {
      await setTranslationJobProcessing({
        jobId,
        relayJobId,
      });
      return;
    } catch (error: any) {
      lastErrorMessage = String(error?.message || error || "unknown error");
      if (attempt >= RELAY_ACCEPTED_PERSIST_MAX_ATTEMPTS) {
        break;
      }
      const backoffMs =
        RELAY_ACCEPTED_PERSIST_RETRY_DELAYS_MS[
          Math.min(attempt - 1, RELAY_ACCEPTED_PERSIST_RETRY_DELAYS_MS.length - 1)
        ] ?? RELAY_ACCEPTED_PERSIST_RETRY_DELAYS_MS.at(-1)!;
      console.warn(
        `[translate/dispatch] Failed to persist relay linkage for ${jobId} (relayJobId=${relayJobId}) requestId=${requestId ?? "-"} attempt=${attempt}/${RELAY_ACCEPTED_PERSIST_MAX_ATTEMPTS}: ${lastErrorMessage}`
      );
      await sleep(backoffMs);
    }
  }

  throw new RelayAcceptedPersistenceError({
    jobId,
    relayJobId,
    attempts: RELAY_ACCEPTED_PERSIST_MAX_ATTEMPTS,
    detail: lastErrorMessage,
  });
}

function clearRelayPollRetryState(jobId: string): void {
  relayPollRetryState.delete(jobId);
}

function noteRelayPollRetryFailure(jobId: string): {
  attempts: number;
  firstAtMs: number;
  lastAtMs: number;
  withinWindow: boolean;
} {
  const now = Date.now();
  const existing = relayPollRetryState.get(jobId);
  if (!existing || now - existing.firstAtMs > MAX_RETRYABLE_RELAY_POLL_FAILURE_WINDOW_MS) {
    const next = { firstAtMs: now, lastAtMs: now, attempts: 1 };
    relayPollRetryState.set(jobId, next);
    return {
      attempts: next.attempts,
      firstAtMs: next.firstAtMs,
      lastAtMs: next.lastAtMs,
      withinWindow: true,
    };
  }

  existing.attempts += 1;
  existing.lastAtMs = now;
  relayPollRetryState.set(jobId, existing);
  return {
    attempts: existing.attempts,
    firstAtMs: existing.firstAtMs,
    lastAtMs: existing.lastAtMs,
    withinWindow:
      now - existing.firstAtMs <= MAX_RETRYABLE_RELAY_POLL_FAILURE_WINDOW_MS,
  };
}


router.post("/", async (c) => {
  const startedAt = Date.now();
  const requestId = getRequestId(c);
  c.header("X-Request-Id", requestId);
  incrementCounter("translate.request_total", { route: "create" });
  const user = c.get("user");

  try {
    if (c.req.raw.signal?.aborted) {
      incrementCounter("translate.request_cancelled_total", { route: "create" });
      return c.json(
        { error: "Request cancelled", message: "Request was cancelled" },
        408
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      incrementCounter("translate.invalid_request_total", { route: "create" });
      return c.json(
        {
          error: API_ERRORS.INVALID_REQUEST,
          details: { formErrors: ["Invalid JSON body"], fieldErrors: {} },
        },
        400
      );
    }

    const parsedBody = translateSchema.safeParse(body);
    if (!parsedBody.success) {
      incrementCounter("translate.invalid_request_total", { route: "create" });
      return c.json(
        {
          error: API_ERRORS.INVALID_REQUEST,
          details: parsedBody.error.flatten(),
        },
        400
      );
    }

    const {
      messages,
      model: requestedModel,
      modelFamily,
      reasoning,
      translationPhase,
      qualityMode,
    } = parsedBody.data;

    // Forward caller model for non-subtitle compatibility. Relay remains authoritative
    // for subtitle draft/review phases via translationPhase + modelFamily.
    const normalizedRequestedModel = normalizeTranslationModel(requestedModel);

    const jobId = crypto.randomUUID();
    const requestIdempotencyKey = getRequestIdempotencyKey(c);
    const payload = {
      mode: "chat" as const,
      messages,
      model: normalizedRequestedModel,
      modelFamily,
      reasoning,
      translationPhase,
      qualityMode,
      idempotencyKey: requestIdempotencyKey ?? null,
      traceId: requestId,
    };

    const admissionResponse = await enforceTranslationAdmission({
      c,
      deviceId: user.deviceId,
      requestId,
    });
    if (admissionResponse) {
      return admissionResponse;
    }

    try {
      await createTranslationJob({
        jobId,
        deviceId: user.deviceId,
        model: normalizedRequestedModel,
        payload,
      });
      incrementCounter("translate.job_created_total");
    } catch (error: any) {
      incrementCounter("translate.job_create_failed_total");
      return c.json(
        {
          error: "Failed to queue translation",
          message: error?.message || "Failed to create translation job",
        },
        { status: 500 }
      );
    }

    const dispatchStartedAt = Date.now();
    try {
      await dispatchQueuedTranslationJobs({
        c,
        preferredJobId: jobId,
        signal: c.req.raw.signal,
        requestId,
      });
      observeDuration(
        "translate.dispatch_from_create_duration_ms",
        Date.now() - dispatchStartedAt,
        { outcome: "ok" }
      );
    } catch (error: any) {
      observeDuration(
        "translate.dispatch_from_create_duration_ms",
        Date.now() - dispatchStartedAt,
        { outcome: "error" }
      );
      incrementCounter("translate.dispatch_run_failed_total", { route: "create" });
      console.warn(
        `[translate] Dispatch queue run failed for ${jobId} requestId=${requestId}:`,
        error?.message || error
      );
    }

    const refreshed = await getTranslationJob({ jobId });
    if (!refreshed) {
      incrementCounter("translate.job_not_found_total", { route: "create" });
      return c.json({ error: "Job not found" }, { status: 404 });
    }

    if (refreshed.status === "completed") {
      incrementCounter("translate.completed_inline_total", { route: "create" });
      return respondWithJobResult(c, refreshed);
    }

    if (refreshed.status === "failed") {
      incrementCounter("translate.failed_total", { route: "create" });
      return respondWithJobFailure(c, refreshed);
    }

    incrementCounter("translate.accepted_total", { route: "create" });
    return c.json(
      {
        jobId,
        status: toClientJobStatus(refreshed.status),
      },
      { status: 202 }
    );
  } finally {
    observeDuration("translate.request_duration_ms", Date.now() - startedAt, {
      route: "create",
    });
  }
});

router.get("/result/:jobId", async (c) => {
  const startedAt = Date.now();
  const requestId = getRequestId(c);
  c.header("X-Request-Id", requestId);
  incrementCounter("translate.request_total", { route: "result" });
  const user = c.get("user");
  const jobId = c.req.param("jobId");

  try {
    const job = await getTranslationJob({ jobId });
    if (!job || job.device_id !== user.deviceId) {
      incrementCounter("translate.job_not_found_total", { route: "result" });
      return c.json({ error: "Job not found" }, { status: 404 });
    }

    if (job.status === "completed") {
      incrementCounter("translate.completed_total", { route: "result" });
      return respondWithJobResult(c, job);
    }

    if (job.status === "failed") {
      incrementCounter("translate.failed_total", { route: "result" });
      return respondWithJobFailure(c, job);
    }

    const payload = parseJobPayload(job);
    if (!payload) {
      incrementCounter("translate.invalid_payload_total", { route: "result" });
      await storeTranslationJobError({ jobId, message: "Invalid payload" });
      return c.json({ error: "Translation job failed" }, { status: 500 });
    }

    if (
      !job.relay_job_id &&
      (job.status === "queued" || job.status === "dispatching")
    ) {
      const dispatchStartedAt = Date.now();
      try {
        await dispatchQueuedTranslationJobs({
          c,
          preferredJobId: jobId,
          signal: c.req.raw.signal,
          requestId,
        });
        observeDuration(
          "translate.dispatch_from_result_duration_ms",
          Date.now() - dispatchStartedAt,
          { outcome: "ok" }
        );
      } catch (error: any) {
        observeDuration(
          "translate.dispatch_from_result_duration_ms",
          Date.now() - dispatchStartedAt,
          { outcome: "error" }
        );
        incrementCounter("translate.dispatch_run_failed_total", {
          route: "result",
        });
        console.warn(
          `[translate/result] Dispatch queue run failed for ${jobId} requestId=${requestId}:`,
          error?.message || error
        );
      }
    }

    const syncResult = await syncJobWithRelay({
      c,
      job,
      payload,
      signal: c.req.raw.signal,
      requestId,
    });

    if (syncResult?.status === "error") {
      incrementCounter("translate.relay_sync_failed_total", {
        code: syncResult.code,
      });
      return c.json({ error: syncResult.message }, { status: syncResult.code });
    }

    const refreshed = await getTranslationJob({ jobId });
    if (!refreshed) {
      incrementCounter("translate.job_not_found_total", { route: "result" });
      return c.json({ error: "Job not found" }, { status: 404 });
    }

    if (refreshed.status === "completed") {
      incrementCounter("translate.completed_total", { route: "result" });
      return respondWithJobResult(c, refreshed);
    }

    if (refreshed.status === "failed") {
      incrementCounter("translate.failed_total", { route: "result" });
      return respondWithJobFailure(c, refreshed);
    }

    incrementCounter("translate.processing_total", { route: "result" });
    return c.json(
      { status: toClientJobStatus(refreshed.status) },
      { status: 202 }
    );
  } finally {
    observeDuration("translate.request_duration_ms", Date.now() - startedAt, {
      route: "result",
    });
  }
});

export default router;

function parseJobPayload(
  job: TranslationJobRecord
): Record<string, unknown> | null {
  try {
    if (!job.payload) return null;
    return JSON.parse(job.payload);
  } catch {
    return null;
  }
}

function toClientJobStatus(status: string): string {
  return status === "dispatching" ? "queued" : status;
}

async function enforceTranslationAdmission({
  c,
  deviceId,
  requestId,
}: {
  c: Context<any>;
  deviceId: string;
  requestId: string;
}): Promise<Response | null> {
  const {
    userMaxActiveJobs,
    globalMaxPendingJobs,
    userRateWindowSec,
    userRateMaxRequests,
  } = getRelayAdmissionConfig(c.env);

  const startedAt = Date.now();
  try {
    incrementCounter("translate.admission_checked_total");
    const [userActiveJobs, userRecentRequests, queued, inFlight] =
      await Promise.all([
        countActiveTranslationJobsForDevice({ deviceId }),
        countRecentTranslationJobsForDevice({
          deviceId,
          windowSeconds: userRateWindowSec,
        }),
        countQueuedTranslationJobs(),
        countTranslationJobsInFlight(),
      ]);
    const pendingGlobalJobs = queued + inFlight;

    if (pendingGlobalJobs >= globalMaxPendingJobs) {
      incrementCounter("translate.admission_rejected_total", {
        reason: "global-pending",
      });
      const { cooldownMs } = getRelayAlertConfig(c.env);
      emitAlert(
        "translate.admission_global_pending",
        `Global translation pending backlog is above threshold (${pendingGlobalJobs} >= ${globalMaxPendingJobs})`,
        {
          cooldownMs,
          context: {
            requestId,
            pendingGlobalJobs,
            globalMaxPendingJobs,
          },
        }
      );

      c.header("Retry-After", "15");
      return c.json(
        {
          error: "translation-queue-overloaded",
          message: "Translation queue is busy. Please retry shortly.",
          reason: "global-pending",
          limits: {
            globalMaxPendingJobs,
            pendingGlobalJobs,
          },
        },
        503
      );
    }

    if (userActiveJobs >= userMaxActiveJobs) {
      incrementCounter("translate.admission_rejected_total", {
        reason: "user-active-jobs",
      });
      c.header("Retry-After", "10");
      return c.json(
        {
          error: "too-many-active-translations",
          message: "Too many active translation jobs for this device.",
          reason: "user-active-jobs",
          limits: {
            userMaxActiveJobs,
            userActiveJobs,
          },
        },
        429
      );
    }

    if (userRecentRequests >= userRateMaxRequests) {
      incrementCounter("translate.admission_rejected_total", {
        reason: "user-rate-limit",
      });
      c.header("Retry-After", String(userRateWindowSec));
      return c.json(
        {
          error: "translation-rate-limit",
          message: "Too many translation requests in a short period.",
          reason: "user-rate-limit",
          limits: {
            userRateWindowSec,
            userRateMaxRequests,
            userRecentRequests,
          },
        },
        429
      );
    }

    incrementCounter("translate.admission_allowed_total");
    return null;
  } finally {
    observeDuration(
      "translate.admission_duration_ms",
      Date.now() - startedAt
    );
  }
}

async function maybeEmitQueueDepthAlert({
  c,
  queuedCount,
}: {
  c: Context<any>;
  queuedCount?: number;
}): Promise<number> {
  const depth = typeof queuedCount === "number" ? queuedCount : await countQueuedTranslationJobs();
  const { queueDepthThreshold, cooldownMs } = getRelayAlertConfig(c.env);
  incrementCounter("translate.queue_depth_sample_total");
  if (depth >= queueDepthThreshold) {
    incrementCounter("translate.queue_depth_threshold_breach_total");
    emitAlert(
      "translate.queue_depth_high",
      `Translation queue depth is high (${depth} >= ${queueDepthThreshold})`,
      {
        cooldownMs,
        context: {
          depth,
          threshold: queueDepthThreshold,
        },
      }
    );
  }
  return depth;
}

async function dispatchQueuedTranslationJobs({
  c,
  preferredJobId,
  signal,
  requestId,
}: {
  c: Context<any>;
  preferredJobId?: string;
  signal?: AbortSignal;
  requestId?: string;
}): Promise<void> {
  const startedAt = Date.now();
  incrementCounter("translate.dispatch_run_total");
  try {
    if (signal?.aborted) {
      incrementCounter("translate.dispatch_cancelled_total");
      return;
    }

    const { maxInFlight, batchSize } = getRelayDispatchConfig(c.env);
    const inFlight = await countTranslationJobsInFlight();
    let availableSlots = Math.max(0, maxInFlight - inFlight);
    if (availableSlots <= 0) {
      incrementCounter("translate.dispatch_saturated_total");
      return;
    }
    const refreshAvailableSlots = async () => {
      const latestInFlight = await countTranslationJobsInFlight();
      return Math.max(0, maxInFlight - latestInFlight);
    };

    const targets: TranslationJobRecord[] = [];
    const seen = new Set<string>();

    if (preferredJobId) {
      const preferredJob = await getTranslationJob({ jobId: preferredJobId });
      if (
        preferredJob &&
        preferredJob.status === "queued" &&
        !preferredJob.relay_job_id
      ) {
        targets.push(preferredJob);
        seen.add(preferredJob.job_id);
      }
    }

    if (availableSlots > targets.length) {
      const queue = await listQueuedTranslationJobs({
        limit: Math.max(batchSize, availableSlots),
      });
      for (const job of queue) {
        if (seen.has(job.job_id)) continue;
        targets.push(job);
        seen.add(job.job_id);
      }
    }

    for (const target of targets) {
      if (signal?.aborted) return;
      if (availableSlots <= 0) return;

      const claimed = await claimTranslationJobDispatch({
        jobId: target.job_id,
        maxInFlight,
      });
      if (!claimed) {
        incrementCounter("translate.dispatch_claim_miss_total");
        availableSlots = await refreshAvailableSlots();
        if (availableSlots <= 0) {
          incrementCounter("translate.dispatch_saturated_total");
          return;
        }
        continue;
      }
      incrementCounter("translate.dispatch_claim_success_total");
      availableSlots -= 1;

      try {
        const dispatchOutcome = await dispatchSingleTranslationJob({
          c,
          jobId: target.job_id,
          signal,
          requestId,
        });
        if (dispatchOutcome === "terminal_failed") {
          consecutiveDispatchFailures += 1;
          incrementCounter("translate.dispatch_failure_total", {
            mode: "terminal",
          });

          const { consecutiveFailuresThreshold, cooldownMs } = getRelayAlertConfig(c.env);
          if (consecutiveDispatchFailures >= consecutiveFailuresThreshold) {
            emitAlert(
              "translate.dispatch_consecutive_failures",
              `Consecutive translation dispatch failures reached ${consecutiveDispatchFailures}`,
              {
                cooldownMs,
                context: {
                  threshold: consecutiveFailuresThreshold,
                  consecutiveFailures: consecutiveDispatchFailures,
                  lastJobId: target.job_id,
                  requestId: requestId ?? null,
                  mode: "terminal",
                },
              }
            );
          }
          continue;
        }

        consecutiveDispatchFailures = 0;
        incrementCounter("translate.dispatch_success_total");
      } catch (error: any) {
        consecutiveDispatchFailures += 1;
        const failureMode =
          error instanceof RelayAcceptedPersistenceError
            ? "post-accept-persist"
            : "retryable";
        incrementCounter("translate.dispatch_failure_total", {
          mode: failureMode,
        });

        if (error instanceof RelayAcceptedPersistenceError) {
          console.error(
            `[translate/dispatch] Job ${target.job_id} relay accepted but linkage persistence failed requestId=${requestId ?? "-"} consecutiveFailures=${consecutiveDispatchFailures} relayJobId=${error.relayJobId}:`,
            error.message
          );
          incrementCounter("translate.dispatch_accept_persist_failed_total");
          try {
            await setTranslationJobQueuedWithRelay({
              jobId: target.job_id,
              relayJobId: error.relayJobId,
            });
            incrementCounter(
              "translate.dispatch_accept_persist_recovered_total"
            );
          } catch (recoveryError: any) {
            console.error(
              `[translate/dispatch] Job ${target.job_id} failed to recover queue state after accepted-relay persistence failure requestId=${requestId ?? "-"} relayJobId=${error.relayJobId}:`,
              recoveryError?.message || recoveryError
            );
          }
        } else {
          console.error(
            `[translate/dispatch] Job ${target.job_id} dispatch failed requestId=${requestId ?? "-"} consecutiveFailures=${consecutiveDispatchFailures}:`,
            error?.message || error
          );
          await resetTranslationJobRelay({ jobId: target.job_id });
        }

        const { consecutiveFailuresThreshold, cooldownMs } = getRelayAlertConfig(c.env);
        if (consecutiveDispatchFailures >= consecutiveFailuresThreshold) {
          emitAlert(
            "translate.dispatch_consecutive_failures",
            `Consecutive translation dispatch failures reached ${consecutiveDispatchFailures}`,
            {
              cooldownMs,
              context: {
                threshold: consecutiveFailuresThreshold,
                consecutiveFailures: consecutiveDispatchFailures,
                lastJobId: target.job_id,
                requestId: requestId ?? null,
                mode: failureMode,
              },
            }
          );
        }
      }
    }

    const queuedAfter = await countQueuedTranslationJobs();
    await maybeEmitQueueDepthAlert({ c, queuedCount: queuedAfter });
  } finally {
    observeDuration("translate.dispatch_run_duration_ms", Date.now() - startedAt);
  }
}

async function dispatchSingleTranslationJob({
  c,
  jobId,
  signal,
  requestId,
}: {
  c: Context<any>;
  jobId: string;
  signal?: AbortSignal;
  requestId?: string;
}): Promise<"ok" | "terminal_failed"> {
  const startedAt = Date.now();
  incrementCounter("translate.dispatch_attempt_total");
  const job = await getTranslationJob({ jobId });
  if (!job) return "ok";

  const payload = parseJobPayload(job);
  if (!payload) {
    incrementCounter("translate.invalid_payload_total", { route: "dispatch" });
    await storeTranslationJobError({ jobId, message: "Invalid payload" });
    return "terminal_failed";
  }

  const relaySubmitStartedAt = Date.now();
  try {
    const submission = await submitTranslationRelayJob({
      c,
      payload,
      signal,
      requestId,
    });
    observeDuration(
      "translate.relay_submit_duration_ms",
      Date.now() - relaySubmitStartedAt,
      { outcome: "ok" }
    );

    if (submission.type === "completed") {
      incrementCounter("translate.dispatch_completed_inline_total");
      const persistResult = await persistCompletion({
        jobId,
        jobOwner: job.device_id,
        payload,
        completion: submission.result,
      });
      if (persistResult.status === "error") {
        incrementCounter("translate.persist_failed_total", {
          code: persistResult.code,
        });
        console.warn(
          `[translate/dispatch] Completion persist failed for ${jobId}: ${persistResult.message}`
        );
        return "terminal_failed";
      }
      return "ok";
    }

    incrementCounter("translate.dispatch_accepted_total");
    await persistAcceptedRelayLink({
      jobId,
      relayJobId: submission.relayJobId,
      requestId,
    });
    return "ok";
  } catch (error: any) {
    observeDuration(
      "translate.relay_submit_duration_ms",
      Date.now() - relaySubmitStartedAt,
      { outcome: "error" }
    );
    if (
      error instanceof RelayHttpError &&
      isRelaySubmitTerminalStatus(error.status)
    ) {
      incrementCounter("translate.relay_client_error_total", {
        status: error.status,
      });
      const terminalFailure = mapRelaySubmitTerminalFailure(error);
      await storeTranslationJobError({
        jobId,
        message: encodeTranslationJobError(terminalFailure),
      });
      return "terminal_failed";
    }

    // Keep job queued for retry by poll/cron reconciliation.
    incrementCounter("translate.relay_submit_failed_total");
    throw error;
  } finally {
    observeDuration(
      "translate.dispatch_attempt_duration_ms",
      Date.now() - startedAt
    );
  }
}

function respondWithJobResult(c: Context<any>, job: TranslationJobRecord) {
  try {
    const parsed = job.result ? JSON.parse(job.result) : {};
    return c.json(parsed);
  } catch {
    return c.json({ error: "Malformed translation result" }, { status: 500 });
  }
}

function respondWithJobFailure(c: Context<any>, job: TranslationJobRecord) {
  const { message, status } = parseTranslationJobError(job.error);
  return c.json({ error: message }, { status });
}

async function syncJobWithRelay({
  c,
  job,
  payload,
  signal,
  requestId,
}: {
  c: Context<any>;
  job: TranslationJobRecord;
  payload: Record<string, unknown>;
  signal?: AbortSignal;
  requestId?: string;
}): Promise<
  { status: "ok" } | { status: "error"; code: ErrorStatusCode; message: string }
> {
  if (!job.relay_job_id) {
    return { status: "ok" };
  }

  const statusStartedAt = Date.now();
  try {
    incrementCounter("translate.relay_status_poll_total");
    const status = await fetchRelayTranslationStatus({
      c,
      relayJobId: job.relay_job_id!,
      signal,
      requestId,
    });
    observeDuration(
      "translate.relay_status_duration_ms",
      Date.now() - statusStartedAt,
      { outcome: "ok" }
    );

    if (status.type === "processing") {
      incrementCounter("translate.relay_status_processing_total");
      clearRelayPollRetryState(job.job_id);
      if (job.status !== "processing") {
        await setTranslationJobProcessing({
          jobId: job.job_id,
          relayJobId: job.relay_job_id,
        });
      }
      return { status: "ok" };
    }

    if (status.type === "completed") {
      clearRelayPollRetryState(job.job_id);
      incrementCounter("translate.relay_status_completed_total");
      const completion = status.result;
      const persistResult = await persistCompletion({
        jobId: job.job_id,
        jobOwner: job.device_id,
        payload,
        completion,
      });

      if (persistResult.status === "error") {
        return persistResult;
      }

      return { status: "ok" };
    }

    if (status.type === "not_found") {
      clearRelayPollRetryState(job.job_id);
      incrementCounter("translate.relay_status_not_found_total");
      await resetTranslationJobRelay({ jobId: job.job_id });
      // Requeue and let dispatch queue submit with backpressure controls.
      return { status: "ok" };
    }

    if (status.type === "retryable_error") {
      incrementCounter("translate.relay_status_retryable_error_total", {
        status: status.statusCode,
      });
      const retryState = noteRelayPollRetryFailure(job.job_id);
      const retryWindowMs = retryState.lastAtMs - retryState.firstAtMs;
      const shouldEscalate =
        retryState.withinWindow &&
        retryState.attempts >= MAX_RETRYABLE_RELAY_POLL_FAILURES;
      if (!shouldEscalate) {
        console.warn(
          `[translate/sync] Retryable relay poll error for ${job.job_id} (${status.message}). attempt=${retryState.attempts}/${MAX_RETRYABLE_RELAY_POLL_FAILURES} windowMs=${retryWindowMs}`
        );
        return { status: "ok" };
      }

      clearRelayPollRetryState(job.job_id);
      const escalationMessage = `Relay status polling unavailable after ${retryState.attempts} attempts in ${Math.round(
        retryWindowMs / 1000
      )}s (${status.message})`;
      await storeTranslationJobError({
        jobId: job.job_id,
        message: encodeTranslationJobError({
          message: escalationMessage,
          statusCode: 503,
        }),
      });
      return {
        status: "error",
        code: 503,
        message: escalationMessage,
      };
    }

    if (status.type === "error") {
      clearRelayPollRetryState(job.job_id);
      incrementCounter("translate.relay_status_error_total");
      await storeTranslationJobError({
        jobId: job.job_id,
        message: status.message,
      });
      return { status: "error", code: 500, message: status.message };
    }

    return { status: "ok" };
  } catch (error: any) {
    observeDuration(
      "translate.relay_status_duration_ms",
      Date.now() - statusStartedAt,
      { outcome: "error" }
    );
    incrementCounter("translate.relay_status_exception_total");
    const retryState = noteRelayPollRetryFailure(job.job_id);
    const retryWindowMs = retryState.lastAtMs - retryState.firstAtMs;
    const shouldEscalate =
      retryState.withinWindow &&
      retryState.attempts >= MAX_RETRYABLE_RELAY_POLL_FAILURES;
    if (!shouldEscalate) {
      console.warn(
        `[translate/sync] Retryable relay status exception for ${job.job_id}. attempt=${retryState.attempts}/${MAX_RETRYABLE_RELAY_POLL_FAILURES} windowMs=${retryWindowMs} error=${error?.message || error}`
      );
      return { status: "ok" };
    }

    clearRelayPollRetryState(job.job_id);
    const escalationMessage =
      error?.message || "Relay status check failed repeatedly";
    await storeTranslationJobError({
      jobId: job.job_id,
      message: encodeTranslationJobError({
        message: escalationMessage,
        statusCode: 503,
      }),
    });
    return {
      status: "error",
      code: 503,
      message: escalationMessage,
    };
  }
}

async function persistCompletion({
  jobId,
  jobOwner,
  payload,
  completion,
}: {
  jobId: string;
  jobOwner: string;
  payload: Record<string, unknown>;
  completion: any;
}): Promise<
  { status: "ok" } | { status: "error"; code: ErrorStatusCode; message: string }
> {
  const startedAt = Date.now();
  incrementCounter("translate.persist_attempt_total");
  try {
    const usage = completion?.usage ?? {};
    const promptTokens =
      typeof usage?.prompt_tokens === "number"
        ? usage.prompt_tokens
        : estimatePromptTokens(payload);
    const completionTokens =
      typeof usage?.completion_tokens === "number"
        ? usage.completion_tokens
        : estimateCompletionTokens(completion);

    await storeTranslationJobResult({
      jobId,
      result: completion,
      promptTokens,
      completionTokens,
    });
    incrementCounter("translate.persist_result_stored_total");

    const job = await getTranslationJob({ jobId });
    if (!job) {
      incrementCounter("translate.persist_failed_total", {
        reason: "job-not-found",
      });
      return { status: "error", code: 500, message: "Job not found" };
    }

    if (!job.credited) {
      const rawCompletionModel =
        typeof completion?.model === "string" ? completion.model.trim() : "";
      if (!rawCompletionModel) {
        incrementCounter("translate.persist_failed_total", {
          reason: "missing-completion-model",
        });
        await storeTranslationJobError({
          jobId,
          message: "unsupported-billing-model:missing-completion-model",
        });
        return {
          status: "error",
          code: 500,
          message: "unsupported-billing-model",
        };
      }

      const billedModel = normalizeTranslationModel(rawCompletionModel);
      if (!isAllowedTranslationModel(billedModel)) {
        incrementCounter("translate.persist_failed_total", {
          reason: "unsupported-billing-model",
        });
        await storeTranslationJobError({
          jobId,
          message: `unsupported-billing-model:${billedModel}`,
        });
        return {
          status: "error",
          code: 500,
          message: "unsupported-billing-model",
        };
      }

      const ok = await deductTranslationCredits({
        deviceId: jobOwner,
        promptTokens: promptTokens ?? 0,
        completionTokens: completionTokens ?? 0,
        model: billedModel,
        idempotencyKey: resolveTranslationBillingIdempotencyKey({
          jobId,
          payload,
        }),
      });

      if (!ok) {
        incrementCounter("translate.persist_failed_total", {
          reason: API_ERRORS.INSUFFICIENT_CREDITS,
        });
        await storeTranslationJobError({
          jobId,
          message: API_ERRORS.INSUFFICIENT_CREDITS,
        });
        return {
          status: "error",
          code: 402,
          message: API_ERRORS.INSUFFICIENT_CREDITS,
        };
      }

      await markTranslationJobCredited({ jobId });
      incrementCounter("translate.credits_deducted_total");

      const provider = getProviderFromModel(billedModel);
      console.log(
        `[translate] success for device ${jobOwner} model=${billedModel} provider=${provider} promptTokens=${promptTokens} completionTokens=${completionTokens}`
      );
    } else {
      incrementCounter("translate.persist_already_credited_total");
    }

    return { status: "ok" };
  } finally {
    observeDuration(
      "translate.persist_attempt_duration_ms",
      Date.now() - startedAt
    );
  }
}

function estimatePromptTokens(payload: Record<string, unknown>): number {
  try {
    const raw = JSON.stringify(payload?.messages ?? payload ?? {});
    return Math.ceil(raw.length / 4);
  } catch {
    return 0;
  }
}

function estimateCompletionTokens(completion: any): number {
  try {
    const content = completion?.choices?.[0]?.message?.content ?? "";
    return Math.ceil(String(content).length / 4);
  } catch {
    return 0;
  }
}

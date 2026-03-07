import { Hono } from "hono";
import crypto from "node:crypto";
import {
  confirmExistingBillingReservation,
  createTranscriptionJob,
  getBillingReservation,
  getTranscriptionJob,
  setTranscriptionJobProcessing,
  storeTranscriptionJobResult,
  storeTranscriptionJobError,
  cleanupOldTranscriptionJobs,
  reserveBillingCredits,
  releaseBillingReservation,
  settleBillingReservation,
} from "../lib/db";
import {
  MAX_FILE_SIZE,
  API_ERRORS,
  STAGE5_API_BASE_URL,
} from "../lib/constants";
import {
  callRelayServer,
  callElevenLabsTranscribeFromR2,
  RelayHttpError,
} from "../lib/openai-config";
import { bearerAuth, type AuthVariables } from "../lib/middleware";
import {
  getRequestIdempotencyKey,
  parseBooleanLike,
} from "../lib/request-utils";
import {
  estimateTranscriptionCredits,
  hasValidRelaySecret,
} from "../lib/relay-billing";
import {
  createJsonReplayEntry,
  deleteStoredJsonReplayArtifact,
  extractStoredJsonReplayEnvelope,
  parseReplayMeta,
  pruneJsonReplayCache,
  resolveStoredJsonReplay,
  storeSuccessJsonReplayArtifact,
  settleJsonReplayEntry,
  type JsonReplayEntry,
  type JsonReplayResult,
  type StoredJsonReplayResult,
} from "../lib/json-replay";
import {
  createDirectRequestLease,
  createWorkerUploadingOwnership,
  persistDirectReplayOrRelease,
  recoverOrRestartDuplicateReservation,
  resolveAbortReservationDisposition,
  startDirectRequestLeaseHeartbeat,
} from "../lib/direct-request-recovery";
import { buildR2TranscriptionReservationKey } from "../lib/transcription-billing";
import {
  createR2Client,
  generateUploadUrl,
  generateDownloadUrl,
  generateFileKey,
  deleteFile,
} from "../lib/r2-config";
import { buildDirectTranscriptionReservationKey } from "../lib/transcription-idempotency";
import { v4 as uuidv4 } from "uuid";
import type { Stage5ApiBindings } from "../types/env";
import {
  STAGE5_ELEVENLABS_SCRIBE_MODEL,
  STAGE5_WHISPER_MODEL,
} from "../lib/model-catalog";

const router = new Hono<{
  Bindings: Stage5ApiBindings;
  Variables: AuthVariables;
}>();

const DEFAULT_TRANSCRIPTION_MODEL = "scribe_v2";
const OPENAI_FALLBACK_TRANSCRIPTION_MODEL = STAGE5_WHISPER_MODEL;
const ELEVENLABS_TRANSCRIPTION_MODEL = STAGE5_ELEVENLABS_SCRIBE_MODEL;
const TRANSCRIPTION_WEBHOOK_TOKEN_SCOPE = "transcribe-r2-webhook-v1";
const WHISPER_MAX_FILE_SIZE_BYTES = Math.max(
  1,
  Number.parseInt(
    process.env.WHISPER_MAX_FILE_SIZE_BYTES || String(25 * 1024 * 1024),
    10
  )
);
const TRANSCRIPTION_RESERVE_PADDING_SECONDS = Math.max(
  0,
  Number.parseInt(process.env.TRANSCRIPTION_RESERVE_PADDING_SECONDS || "2", 10)
);
const TRANSCRIPTION_RESERVE_FLOOR_BYTES_PER_SECOND = Math.max(
  1,
  // Reserve against compressed speech files too; 16 kbps audio is roughly 2000 B/s.
  Number.parseInt(
    process.env.TRANSCRIPTION_RESERVE_FLOOR_BYTES_PER_SECOND || "2000",
    10
  )
);
const TRANSCRIPTION_REPLAY_TTL_MS = Math.max(
  1_000,
  Number.parseInt(
    process.env.TRANSCRIPTION_REPLAY_TTL_MS || String(10 * 60 * 1_000),
    10
  )
);
const transcriptionReplayCache = new Map<string, JsonReplayEntry>();


function normalizeTranscriptionModelForBilling(model?: string): string {
  const normalized = (model || "").trim().toLowerCase();
  if (normalized.includes("whisper")) {
    return OPENAI_FALLBACK_TRANSCRIPTION_MODEL;
  }
  return ELEVENLABS_TRANSCRIPTION_MODEL;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function deriveDurationSecondsFromTimings(payload: any): number | null {
  let maxEnd = 0;

  const segments = payload?.segments;
  if (Array.isArray(segments)) {
    for (const seg of segments) {
      if (isFiniteNumber(seg?.end) && seg.end > maxEnd) maxEnd = seg.end;

      // Some providers include word timings nested inside segments.
      const segWords = seg?.words;
      if (Array.isArray(segWords)) {
        for (const w of segWords) {
          if (isFiniteNumber(w?.end) && w.end > maxEnd) maxEnd = w.end;
        }
      }
    }
  }

  const words = payload?.words;
  if (Array.isArray(words)) {
    for (const w of words) {
      if (isFiniteNumber(w?.end) && w.end > maxEnd) maxEnd = w.end;
    }
  }

  if (!Number.isFinite(maxEnd) || maxEnd <= 0) return null;
  return maxEnd;
}

/**
 * Returns a duration (seconds) suitable for billing:
 * - Prefer explicit `duration` / `approx_duration`.
 * - Otherwise derive from segment/word timing data.
 * - If there's no content at all, return 0 (no billing).
 * - If there is content but we can't determine duration, return null (fail closed).
 */
function getBillingDurationSeconds(payload: any): number | null {
  const raw = payload?.duration ?? payload?.approx_duration;
  if (isFiniteNumber(raw) && raw > 0) return raw;

  const derived = deriveDurationSecondsFromTimings(payload);
  if (derived !== null) return derived;

  const hasText =
    typeof payload?.text === "string" && payload.text.trim().length > 0;
  const hasSegments = Array.isArray(payload?.segments) && payload.segments.length > 0;
  const hasWords = Array.isArray(payload?.words) && payload.words.length > 0;

  // Nothing transcribed -> allow through with zero duration (no charge).
  if (!hasText && !hasSegments && !hasWords) return 0;

  // Content exists but duration is missing/unknowable -> refuse to return results without charging.
  return null;
}

function extractRelayErrorMessage(body: string, fallback: string): string {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const message = (parsed as any).message;
      if (typeof message === "string" && message.trim()) {
        return message.trim();
      }
      const error = (parsed as any).error;
      if (typeof error === "string" && error.trim()) {
        return error.trim();
      }
    }
  } catch {
    // Fall through to the raw body.
  }

  return body.trim() || fallback;
}

function resolveDirectTranscriptionQuality({
  explicitQualityRaw,
  modelHint,
}: {
  explicitQualityRaw: unknown;
  modelHint?: string;
}): {
  useHighQuality: boolean;
  source: "explicit" | "model-hint" | "default";
} {
  const explicit = parseBooleanLike(explicitQualityRaw);
  if (typeof explicit === "boolean") {
    return { useHighQuality: explicit, source: "explicit" };
  }

  const normalizedHint =
    typeof modelHint === "string" ? modelHint.trim().toLowerCase() : "";
  const hintTokens = normalizedHint.split(/[^a-z0-9]+/).filter(Boolean);
  if (hintTokens.includes("whisper")) {
    return { useHighQuality: false, source: "model-hint" };
  }
  if (hintTokens.includes("scribe") || hintTokens.includes("elevenlabs")) {
    return { useHighQuality: true, source: "model-hint" };
  }

  return { useHighQuality: true, source: "default" };
}

function getWhisperFileSizeGuardMessage(fileSizeBytes: number): string | null {
  if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) return null;
  if (fileSizeBytes <= WHISPER_MAX_FILE_SIZE_BYTES) return null;
  const currentMB = (fileSizeBytes / (1024 * 1024)).toFixed(1);
  const maxMB = (WHISPER_MAX_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(1);
  return `File is ${currentMB}MB; Whisper supports up to ${maxMB}MB per request.`;
}

function buildTranscriptionFallbackConfirmationPayload({
  requestedReserveSpend,
  fallbackReserveSpend,
  reason,
  whisperGuardMessage,
}: {
  requestedReserveSpend: number;
  fallbackReserveSpend: number;
  reason: "insufficient-credits" | "provider-unavailable";
  whisperGuardMessage?: string | null;
}): {
  error: "transcription-fallback-confirmation-required";
  message: string;
  reason: "insufficient-credits" | "provider-unavailable";
  requestedModel: string;
  fallbackModel: string;
  requestedReserveSpend: number;
  fallbackReserveSpend: number;
  whisperGuardMessage?: string;
} {
  const message =
    reason === "insufficient-credits"
      ? "High-quality transcription needs more credits. Continue with Whisper instead, or recharge to keep ElevenLabs quality."
      : "High-quality transcription is unavailable right now. Continue with Whisper instead, or retry later to keep ElevenLabs quality.";

  return {
    error: "transcription-fallback-confirmation-required",
    message,
    reason,
    requestedModel: ELEVENLABS_TRANSCRIPTION_MODEL,
    fallbackModel: OPENAI_FALLBACK_TRANSCRIPTION_MODEL,
    requestedReserveSpend,
    fallbackReserveSpend,
    ...(whisperGuardMessage ? { whisperGuardMessage } : {}),
  };
}

function parseRequestedDurationSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }

  const parsed = Number.parseFloat(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function toReservationSeconds(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 0;
  }
  return Math.ceil(durationSeconds) + TRANSCRIPTION_RESERVE_PADDING_SECONDS;
}

function estimateReservationSecondsFromFileSize(fileSizeBytes: number): number {
  if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) {
    return 0;
  }
  return (
    Math.ceil(fileSizeBytes / TRANSCRIPTION_RESERVE_FLOOR_BYTES_PER_SECOND) +
    TRANSCRIPTION_RESERVE_PADDING_SECONDS
  );
}

// This is only the worker-side provisional hold. The relay later probes the
// uploaded media and performs an exact confirm before vendor work starts.
function resolveInitialReservationSeconds({
  requestedDurationSeconds,
  fileSizeBytes,
}: {
  requestedDurationSeconds?: number | null;
  fileSizeBytes: number;
}): number {
  return Math.max(
    toReservationSeconds(requestedDurationSeconds ?? 0),
    estimateReservationSecondsFromFileSize(fileSizeBytes)
  );
}

function buildR2TranscriptionWebhookToken({
  jobId,
  relaySecret,
}: {
  jobId: string;
  relaySecret: string;
}): string {
  return crypto
    .createHmac("sha256", relaySecret)
    .update(`${TRANSCRIPTION_WEBHOOK_TOKEN_SCOPE}:${jobId}`)
    .digest("base64url");
}

function hasMatchingWebhookToken({
  expectedToken,
  providedToken,
}: {
  expectedToken: string;
  providedToken: string;
}): boolean {
  if (!expectedToken || !providedToken) {
    return false;
  }

  const expectedBytes = new TextEncoder().encode(expectedToken);
  const providedBytes = new TextEncoder().encode(providedToken);
  if (expectedBytes.length !== providedBytes.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBytes, providedBytes);
}

async function reserveTranscriptionCredits({
  deviceId,
  requestKey,
  reserveSeconds,
  reserveModel,
  meta,
}: {
  deviceId: string;
  requestKey: string;
  reserveSeconds: number;
  reserveModel: string;
  meta?: unknown;
}): Promise<
  | { ok: true; status: "reserved" }
  | {
      ok: true;
      status: "duplicate";
      reservationStatus: "reserved" | "settled" | "released";
      reservationMeta: string | null;
      reservationUpdatedAt: string | null;
      storedReplay: StoredJsonReplayResult | null;
    }
  | { ok: false; error: "insufficient-credits" }
> {
  const reserveSpend = estimateTranscriptionCredits({
    seconds: reserveSeconds,
    model: reserveModel,
  });
  const result = await reserveBillingCredits({
    deviceId,
    service: "transcription",
    requestKey,
    spend: reserveSpend,
    reason: "TRANSCRIBE_RESERVE",
    meta: {
      reserveSeconds,
      reserveModel,
      reserveSpend,
      ...(meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {}),
    },
  });
  if (!result.ok) {
    return result;
  }
  if (result.status === "duplicate") {
    if (
      result.reservation.status !== "reserved" &&
      result.reservation.status !== "settled" &&
      result.reservation.status !== "released"
    ) {
      throw new Error(
        `Unexpected duplicate transcription reservation status: ${result.reservation.status}`
      );
    }
    return {
      ok: true,
      status: "duplicate",
      reservationStatus: result.reservation.status,
      reservationMeta: result.reservation.meta,
      reservationUpdatedAt: result.reservation.updated_at,
      storedReplay: extractStoredJsonReplayEnvelope(
        parseReplayMeta(result.reservation.meta)
      ),
    };
  }
  return { ok: true, status: "reserved" };
}

async function findExistingDirectTranscriptionReservation({
  deviceId,
  requestKey,
}: {
  deviceId: string;
  requestKey: string;
}): Promise<
  | {
      status: "duplicate";
      reservationStatus: "reserved" | "settled" | "released";
      reservationMeta: string | null;
      reservationUpdatedAt: string | null;
      storedReplay: StoredJsonReplayResult | null;
    }
  | null
> {
  const reservation = await getBillingReservation({
    deviceId,
    service: "transcription",
    requestKey,
  });
  if (!reservation) {
    return null;
  }
  if (
    reservation.status !== "reserved" &&
    reservation.status !== "settled" &&
    reservation.status !== "released"
  ) {
    return null;
  }
  if (reservation.status === "released") {
    return null;
  }
  const storedReplay = extractStoredJsonReplayEnvelope(
    parseReplayMeta(reservation.meta)
  );
  return {
    status: "duplicate",
    reservationStatus: reservation.status,
    reservationMeta: reservation.meta,
    reservationUpdatedAt: reservation.updated_at,
    storedReplay,
  };
}

function buildDuplicateDirectTranscriptionResponse(
  duplicate: {
    reservationStatus: "reserved" | "settled" | "released";
    replayResult: JsonReplayResult | null;
  }
): JsonReplayResult {
  if (duplicate.reservationStatus === "settled" && duplicate.replayResult) {
    return duplicate.replayResult;
  }
  return {
    kind: "error",
    status: 409,
    body: {
      error: "duplicate-request-in-progress",
      message:
        "A transcription request with this idempotency key is already in progress.",
    },
  };
}

function buildStoredTranscriptionReplayMeta(
  storedReplay: StoredJsonReplayResult | null,
): Record<string, unknown> {
  if (!storedReplay) {
    return {};
  }
  return {
    directReplayResult: storedReplay,
  };
}

async function loadStoredTranscriptionReplay({
  bucket,
  storedReplay,
}: {
  bucket: R2Bucket;
  storedReplay: StoredJsonReplayResult | null;
}): Promise<JsonReplayResult | null> {
  return resolveStoredJsonReplay({
    bucket,
    storedReplay,
  });
}

type PendingDirectTranscriptionFinalize = {
  actualSeconds: number;
  billedModel: string;
  settlementMeta: Record<string, unknown>;
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function extractPendingDirectTranscriptionFinalize(
  reservationMeta: unknown
): PendingDirectTranscriptionFinalize | null {
  const metaObject = asObject(reservationMeta);
  const pendingObject = asObject(metaObject?.pendingFinalize);
  const settlementMeta = asObject(pendingObject?.settlementMeta);
  const actualSeconds = Number(pendingObject?.actualSeconds);
  const billedModel =
    typeof pendingObject?.billedModel === "string"
      ? pendingObject.billedModel.trim()
      : "";
  if (
    !settlementMeta ||
    !billedModel ||
    !Number.isFinite(actualSeconds) ||
    actualSeconds < 0
  ) {
    return null;
  }

  return {
    actualSeconds,
    billedModel,
    settlementMeta,
  };
}

async function resolveDuplicateDirectTranscriptionReservation({
  bucket,
  deviceId,
  requestKey,
  duplicate,
}: {
  bucket: R2Bucket;
  deviceId: string;
  requestKey: string;
  duplicate: {
    reservationStatus: "reserved" | "settled" | "released";
    reservationMeta?: string | null;
    reservationUpdatedAt?: string | null;
    storedReplay: StoredJsonReplayResult | null;
  };
}): Promise<
  | { action: "retry-reserve" }
  | { action: "respond"; replay: JsonReplayResult; cacheSuccess?: boolean }
> {
  const replayResult = await loadStoredTranscriptionReplay({
    bucket,
    storedReplay: duplicate.storedReplay,
  });
  if (duplicate.reservationStatus === "released") {
    return { action: "retry-reserve" };
  }
  if (duplicate.reservationStatus === "settled" && replayResult) {
    return {
      action: "respond",
      replay: replayResult,
      cacheSuccess: replayResult.kind === "success",
    };
  }

  const pendingFinalize = extractPendingDirectTranscriptionFinalize(
    parseReplayMeta(duplicate.reservationMeta)
  );
  if (duplicate.storedReplay && replayResult && pendingFinalize) {
    const finalizeResult = await finalizeTranscriptionCredits({
      deviceId,
      requestKey,
      actualSeconds: pendingFinalize.actualSeconds,
      billedModel: pendingFinalize.billedModel,
      meta: {
        ...pendingFinalize.settlementMeta,
        ...buildStoredTranscriptionReplayMeta(duplicate.storedReplay),
        pendingFinalize: null,
      },
    });
    if (finalizeResult.ok) {
      return {
        action: "respond",
        replay: replayResult,
        cacheSuccess: replayResult.kind === "success",
      };
    }

    return {
      action: "respond",
      replay: {
        kind: "error",
        status: finalizeResult.status,
        body: {
          error: finalizeResult.error,
          message: "Failed to finalize transcription billing",
        },
      },
    };
  }

  const recovery = await recoverOrRestartDuplicateReservation({
    deviceId,
    requestKey,
    service: "transcription",
    reservation: {
      status: duplicate.reservationStatus,
      meta: duplicate.reservationMeta ?? null,
      updated_at: duplicate.reservationUpdatedAt ?? null,
    },
    releaseReason: "TRANSCRIBE",
    releaseMeta: {
      recoveryReason: "stale-direct-transcription-retry",
    },
  });
  if (!recovery.ok) {
    return {
      action: "respond",
      replay: {
        kind: "error",
        status: recovery.status,
        body: {
          error:
            recovery.status === 409
              ? "duplicate-request-in-progress"
              : "duplicate-request-recovery-failed",
          message: recovery.error,
        },
      },
    };
  }
  if (recovery.action === "retry-reserve") {
    return { action: "retry-reserve" };
  }

  const settledStoredReplay = extractStoredJsonReplayEnvelope(
    parseReplayMeta(recovery.reservationMeta)
  );
  const settledReplay = await loadStoredTranscriptionReplay({
    bucket,
    storedReplay: settledStoredReplay,
  });
  if (settledReplay?.kind === "success") {
    return {
      action: "respond",
      replay: settledReplay,
      cacheSuccess: true,
    };
  }

  return {
    action: "respond",
    replay: buildDuplicateDirectTranscriptionResponse({
      reservationStatus: "settled",
      replayResult: settledReplay,
    }),
  };
}

async function finalizeTranscriptionCredits({
  deviceId,
  requestKey,
  actualSeconds,
  billedModel,
  meta,
}: {
  deviceId: string;
  requestKey: string;
  actualSeconds: number;
  billedModel: string;
  meta?: unknown;
}): Promise<
  | { ok: true }
  | { ok: false; status: 409 | 500; error: string }
> {
  const actualSpend = estimateTranscriptionCredits({
    seconds: actualSeconds,
    model: billedModel,
  });
  const result = await settleBillingReservation({
    deviceId,
    service: "transcription",
    requestKey,
    actualSpend,
    reason: "TRANSCRIBE",
    meta: {
      billedModel,
      actualSeconds,
      actualSpend,
      ...(meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {}),
    },
  });
  if (!result.ok) {
    return {
      ok: false,
      status: result.error === "actual-spend-exceeds-reserve" ? 409 : 500,
      error: result.error,
    };
  }
  return { ok: true };
}

async function releaseTranscriptionReservation({
  deviceId,
  requestKey,
  meta,
}: {
  deviceId: string;
  requestKey: string;
  meta?: unknown;
}): Promise<void> {
  await releaseBillingReservation({
    deviceId,
    service: "transcription",
    requestKey,
    reason: "TRANSCRIBE",
    meta,
  });
}

/**
 * TODO(stage5-cleanup): Remove with legacy R2 transcription flow.
 * POST /webhook/:jobId
 * Called by the relay when transcription completes (legacy R2 flow)
 */
router.post("/webhook/:jobId", async (c) => {
  const jobId = c.req.param("jobId");

  const relaySecret = c.req.header("X-Relay-Secret");
  const webhookToken = String(c.req.header("X-Stage5-Webhook-Token") || "").trim();
  const expectedWebhookToken = buildR2TranscriptionWebhookToken({
    jobId,
    relaySecret: c.env.RELAY_SECRET,
  });
  if (
    !hasValidRelaySecret(relaySecret, c.env.RELAY_SECRET) ||
    !hasMatchingWebhookToken({
      expectedToken: expectedWebhookToken,
      providedToken: webhookToken,
    })
  ) {
    console.error(`[transcribe/webhook] Invalid webhook token for job ${jobId}`);
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await c.req.json();
    const { success, result, error } = body as {
      success: boolean;
      result?: any;
      error?: string;
    };

    // Get the job to verify it exists and get device info
    const job = await getTranscriptionJob({ jobId });
    if (!job) {
      console.error(`[transcribe/webhook] Job ${jobId} not found`);
      return c.json({ error: "Job not found" }, 404);
    }

    if (job.status !== "processing") {
      console.warn(
        `[transcribe/webhook] Job ${jobId} not in processing state: ${job.status}`
      );
      // Still process it to avoid losing data
    }

    const cleanupR2File = async (context: string) => {
      if (!job.file_key) return;
      try {
        await deleteFile(c.env.TRANSCRIPTION_BUCKET, job.file_key);
        console.log(
          `[transcribe/webhook] Cleaned up R2 file (${context}): ${job.file_key}`
        );
      } catch (cleanupErr) {
        console.warn(
          `[transcribe/webhook] Failed to cleanup R2 file (${context}) ${job.file_key}`
        );
      }
    };

    if (!success) {
      console.error(`[transcribe/webhook] Job ${jobId} failed: ${error}`);
      await storeTranscriptionJobError({
        jobId,
        message: error || "Transcription failed",
      });
      await releaseTranscriptionReservation({
        deviceId: job.device_id,
        requestKey: buildR2TranscriptionReservationKey(jobId),
        meta: { reason: "relay-webhook-failure" },
      });

      await cleanupR2File("failure");

      return c.json({ status: "error_recorded" });
    }

    const billingDur = getBillingDurationSeconds(result);
    if (billingDur === null) {
      console.error(
        `[transcribe/webhook] Refusing to finalize job ${jobId}: missing duration for billing`
      );
      await storeTranscriptionJobError({
        jobId,
        message: "billing-duration-unavailable",
      });
      await releaseTranscriptionReservation({
        deviceId: job.device_id,
        requestKey: buildR2TranscriptionReservationKey(jobId),
        meta: { reason: "billing-duration-unavailable" },
      });
      await cleanupR2File("billing-duration-unavailable");
      return c.json({ status: "billing_duration_unavailable" }, 500);
    }

    const seconds = Math.ceil(billingDur);
    const finalized = await finalizeTranscriptionCredits({
      deviceId: job.device_id,
      requestKey: buildR2TranscriptionReservationKey(jobId),
      actualSeconds: seconds,
      billedModel: STAGE5_ELEVENLABS_SCRIBE_MODEL,
      meta: { source: "r2-webhook", jobId },
    });

    if (!finalized.ok) {
      await storeTranscriptionJobError({
        jobId,
        message: finalized.error,
      });
      await cleanupR2File(finalized.error);
      return c.json({ status: finalized.error }, finalized.status);
    }

    console.log(
      `[transcribe/webhook] Job ${jobId} completed, ${seconds}s transcribed`
    );

    await storeTranscriptionJobResult({
      jobId,
      result,
      durationSeconds: seconds,
    });

    await cleanupR2File("success");

    return c.json({ status: "success" });
  } catch (error: any) {
    console.error(`[transcribe/webhook] Error processing job ${jobId}:`, error);
    return c.json(
      { error: "Webhook processing failed", message: error.message },
      500
    );
  }
});

// Use shared auth middleware for all other routes
router.use("*", bearerAuth());

router.post("/", async (c) => {
  const user = c.get("user");
  let reservationRequestKey: string | null = null;
  let reservationActive = false;
  let stopDirectRequestLeaseHeartbeat: (() => void) | null = null;
  let replayContext:
    | { requestKey: string; entry: JsonReplayEntry }
    | null = null;
  const respondReplay = (
    replay: JsonReplayResult,
    cacheSuccess = replay.kind === "success"
  ) => {
    if (replayContext) {
      settleJsonReplayEntry({
        cache: transcriptionReplayCache,
        requestKey: replayContext.requestKey,
        entry: replayContext.entry,
        result: replay,
        ttlMs: TRANSCRIPTION_REPLAY_TTL_MS,
        cacheSuccess,
      });
    }
    return c.json(replay.body as any, replay.status as any);
  };
  const releaseActiveReservation = async ({
    reason,
    message,
  }: {
    reason: string;
    message?: string;
  }): Promise<void> => {
    if (!reservationRequestKey || !reservationActive) return;
    await releaseTranscriptionReservation({
      deviceId: user.deviceId,
      requestKey: reservationRequestKey,
      meta: {
        reason,
        ...(message ? { message } : {}),
      },
    });
    reservationActive = false;
  };

  try {
    // Check if request was already aborted
    if (c.req.raw.signal?.aborted) {
      return c.json(
        { error: "Request cancelled", message: "Request was cancelled" },
        408 // Request Timeout - closest standard status for client cancellation
      );
    }

    const formData = await c.req.formData();
    const file = formData.get("file");
    const requestedModel =
      formData.get("model")?.toString()?.trim() ||
      DEFAULT_TRANSCRIPTION_MODEL;
    const requestedQualityMode =
      formData.get("qualityMode")?.toString() ??
      formData.get("quality_mode")?.toString();
    const requestedDurationSeconds = parseRequestedDurationSeconds(
      formData.get("durationSec")?.toString() ??
        formData.get("durationSeconds")?.toString()
    );
    const qualityMode = parseBooleanLike(requestedQualityMode);
    const language = formData.get("language")?.toString();
    const prompt = formData.get("prompt")?.toString();
    // New pricing is default; legacy flags are ignored

    if (!(file instanceof File)) {
      return c.json(
        { error: API_ERRORS.INVALID_REQUEST, message: "File is required" },
        400
      );
    }

    // File size limit check
    if (file.size > MAX_FILE_SIZE) {
      return c.json(
        {
          error: API_ERRORS.FILE_TOO_LARGE,
          message: `File size exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB limit`,
        },
        413
      );
    }

    // Check again before expensive operation
    if (c.req.raw.signal?.aborted) {
      return c.json(
        { error: "Request cancelled", message: "Request was cancelled" },
        408
      );
    }
    const idempotencyKey = getRequestIdempotencyKey(c);
    // A caller may reuse the same idempotency key for a corrected retry, so the
    // reservation identity must include file content, not only upload metadata.
    const requestKey =
      (await buildDirectTranscriptionReservationKey({
        requestIdempotencyKey: idempotencyKey,
        deviceId: user.deviceId,
        file,
        requestedModel,
        qualityMode: typeof qualityMode === "boolean" ? qualityMode : "auto",
        language: language ?? null,
        prompt: prompt ?? null,
      })) ||
      `transcribe-direct-billing-v1:${crypto.randomUUID()}`;
    const directRequestLease = createDirectRequestLease();
    const directRequestOwnership = createWorkerUploadingOwnership();
    reservationRequestKey = requestKey;
    pruneJsonReplayCache(transcriptionReplayCache);
    const existingReplay = transcriptionReplayCache.get(requestKey);
    if (existingReplay) {
      const replay = existingReplay.result ?? (await existingReplay.promise);
      return c.json(replay.body as any, replay.status as any);
    }
    const replayEntry = createJsonReplayEntry();
    transcriptionReplayCache.set(requestKey, replayEntry);
    replayContext = { requestKey, entry: replayEntry };
    const existingReservation = await findExistingDirectTranscriptionReservation({
      deviceId: user.deviceId,
      requestKey,
    });
    if (existingReservation) {
      const duplicateResolution =
        await resolveDuplicateDirectTranscriptionReservation({
          bucket: c.env.TRANSCRIPTION_BUCKET,
          deviceId: user.deviceId,
          requestKey,
          duplicate: existingReservation,
        });
      if (duplicateResolution.action === "respond") {
        return respondReplay(
          duplicateResolution.replay,
          duplicateResolution.cacheSuccess
        );
      }
    }
    const reserveSeconds = resolveInitialReservationSeconds({
      requestedDurationSeconds,
      fileSizeBytes: file.size,
    });
    const requestedQuality = resolveDirectTranscriptionQuality({
      explicitQualityRaw: requestedQualityMode,
      modelHint: requestedModel,
    });
    const whisperGuardMessage = getWhisperFileSizeGuardMessage(file.size);
    const requestedReserveModel = requestedQuality.useHighQuality
      ? ELEVENLABS_TRANSCRIPTION_MODEL
      : OPENAI_FALLBACK_TRANSCRIPTION_MODEL;
    const requestedReserveSpend = estimateTranscriptionCredits({
      seconds: reserveSeconds,
      model: requestedReserveModel,
    });
    const whisperReserveSpend = estimateTranscriptionCredits({
      seconds: reserveSeconds,
      model: OPENAI_FALLBACK_TRANSCRIPTION_MODEL,
    });
    const whisperFallbackAvailable = whisperGuardMessage === null;

    if (
      requestedQuality.useHighQuality &&
      whisperFallbackAvailable &&
      !c.env.ELEVENLABS_API_KEY &&
      c.env.OPENAI_API_KEY
    ) {
      return respondReplay({
        kind: "error",
        status: 409,
        body: buildTranscriptionFallbackConfirmationPayload({
          requestedReserveSpend,
          fallbackReserveSpend: whisperReserveSpend,
          reason: "provider-unavailable",
          whisperGuardMessage,
        }),
      });
    }

    if (
      requestedQuality.useHighQuality &&
      whisperFallbackAvailable &&
      requestedReserveSpend > user.creditBalance &&
      whisperReserveSpend <= user.creditBalance
    ) {
      return respondReplay({
        kind: "error",
        status: 409,
        body: buildTranscriptionFallbackConfirmationPayload({
          requestedReserveSpend,
          fallbackReserveSpend: whisperReserveSpend,
          reason: "insufficient-credits",
          whisperGuardMessage,
        }),
      });
    }

    let reserved:
      | Awaited<ReturnType<typeof reserveTranscriptionCredits>>
      | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      reserved = await reserveTranscriptionCredits({
        deviceId: user.deviceId,
        requestKey,
        reserveSeconds,
        reserveModel: requestedReserveModel,
        meta: {
          source: "relay-worker",
          fileSizeBytes: file.size,
          requestedModel,
          qualityMode: typeof qualityMode === "boolean" ? qualityMode : "auto",
          language: language ?? null,
          requestedDurationSeconds,
          reserveModel: requestedReserveModel,
          qualitySource: requestedQuality.source,
          directRequestLease,
          directRequestOwnership,
        },
      });
      if (!reserved.ok) {
        return respondReplay({
          kind: "error",
          status: 402,
          body: { error: API_ERRORS.INSUFFICIENT_CREDITS },
        });
      }
      if (reserved.status === "reserved") {
        break;
      }

      const duplicateResolution =
        await resolveDuplicateDirectTranscriptionReservation({
          bucket: c.env.TRANSCRIPTION_BUCKET,
          deviceId: user.deviceId,
          requestKey,
          duplicate: {
            reservationStatus: reserved.reservationStatus,
            reservationMeta: reserved.reservationMeta,
            reservationUpdatedAt: reserved.reservationUpdatedAt,
            storedReplay: reserved.storedReplay,
          },
        });
      if (duplicateResolution.action === "respond") {
        return respondReplay(
          duplicateResolution.replay,
          duplicateResolution.cacheSuccess
        );
      }
    }
    if (!reserved || !reserved.ok || reserved.status !== "reserved") {
      return respondReplay({
        kind: "error",
        status: 409,
        body: {
          error: "duplicate-request-in-progress",
          message:
            "A transcription request with this idempotency key is already in progress.",
        },
      });
    }
    reservationActive = true;
    stopDirectRequestLeaseHeartbeat = startDirectRequestLeaseHeartbeat({
      deviceId: user.deviceId,
      requestKey,
      service: "transcription",
      lease: directRequestLease,
    });

    // Create a combined abort signal that responds to both client cancellation and server timeout
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, 300000); // 5 minute server-side timeout

    // Listen for client cancellation
    c.req.raw.signal?.addEventListener("abort", () => {
      clearTimeout(timeoutId);
      abortController.abort();
    });

    let transcription;
    try {
      transcription = await callRelayServer({
        c,
        file,
        model: requestedModel,
        qualityMode,
        language: language ?? undefined,
        prompt: prompt ?? undefined,
        signal: abortController.signal,
        deviceId: user.deviceId,
        requestKey,
        idempotencyKey: idempotencyKey ?? undefined,
      });
    } catch (relayError: any) {
      if (
        relayError.name === "AbortError" ||
        abortController.signal.aborted
      ) {
        const wasCancelled = c.req.raw.signal?.aborted;
        const disposition = await resolveAbortReservationDisposition({
          deviceId: user.deviceId,
          requestKey,
          service: "transcription",
        });
        if (disposition.action === "release") {
          await releaseActiveReservation({
            reason: "relay-upload-aborted-before-ownership",
            message: wasCancelled ? "client-cancelled-upload" : "upload-timeout",
          });
          console.warn(
            `[transcribe] released reservation after ${
              wasCancelled ? "client cancel" : "timeout"
            } before relay ownership for requestKey=${requestKey}`
          );
        } else {
          console.warn(
            `[transcribe] preserving reservation after ${
              wasCancelled ? "client cancel" : "timeout"
            } for requestKey=${requestKey}; relay already owns the request`
          );
        }
        return respondReplay({
          kind: "error",
          status: 408,
          body: {
            error: wasCancelled ? "Request cancelled" : "Request timeout",
            message: wasCancelled
              ? "Request was cancelled by client"
              : "Request exceeded timeout limit",
          },
        });
      }
      if (relayError instanceof RelayHttpError) {
        const message = extractRelayErrorMessage(
          relayError.body || "",
          relayError.message
        );
        await releaseActiveReservation({
          reason: "relay-http-error",
          message,
        });
        return respondReplay({
          kind: "error",
          status: relayError.status,
          body: {
            error: "relay-transcription-failed",
            message,
          },
        });
      }
      throw relayError;
    } finally {
      clearTimeout(timeoutId);
    }

    // Once the relay has produced a successful transcript, finish settlement and
    // store replay state even if the client disconnected. That keeps retries
    // idempotent instead of re-running vendor work.
    if (c.req.raw.signal?.aborted) {
      console.warn(
        `[transcribe] client disconnected after relay success; finalizing replay state for requestKey=${requestKey}`
      );
    }

    const billedModel = normalizeTranscriptionModelForBilling(
      typeof (transcription as any)?.model === "string"
        ? (transcription as any).model
        : requestedModel
    );
    const provider =
      billedModel === OPENAI_FALLBACK_TRANSCRIPTION_MODEL
        ? "OpenAI"
        : "ElevenLabs";
    const billingDur = getBillingDurationSeconds(transcription as any);
    if (billingDur === null) {
      await releaseActiveReservation({
        reason: "billing-duration-unavailable",
      });
      return respondReplay({
        kind: "error",
        status: 502,
        body: {
          error: "billing-duration-unavailable",
          message:
            "Unable to determine transcription duration for billing. Please retry.",
        },
      });
    }
    const actualSeconds = Math.ceil(billingDur);
    const responsePayload = transcription as any;
    const replaySuccess: JsonReplayResult = {
      kind: "success",
      status: 200,
      body: responsePayload,
    };
    const settlementMeta = {
      source: "relay-worker",
      fileSizeBytes: file.size,
      requestedModel,
      qualityMode: typeof qualityMode === "boolean" ? qualityMode : "auto",
      language: language ?? null,
      provider,
    };
    const pendingFinalize: PendingDirectTranscriptionFinalize = {
      actualSeconds,
      billedModel,
      settlementMeta,
    };
    const storedReplaySuccess = await storeSuccessJsonReplayArtifact({
      bucket: c.env.TRANSCRIPTION_BUCKET,
      service: "transcription",
      deviceId: user.deviceId,
      requestKey,
      replay: replaySuccess,
    });
    const persistResult = await persistDirectReplayOrRelease({
      deviceId: user.deviceId,
      requestKey,
      service: "transcription",
      replayResult: storedReplaySuccess,
      pendingFinalize,
      releaseReason: "TRANSCRIBE",
    });
    if (!persistResult.ok) {
      await deleteStoredJsonReplayArtifact({
        bucket: c.env.TRANSCRIPTION_BUCKET,
        storedReplay: storedReplaySuccess,
      });
      if (persistResult.released) {
        reservationActive = false;
      }
      return respondReplay({
        kind: "error",
        status: persistResult.status,
        body: {
          error: persistResult.error,
          message: persistResult.details || "Failed to persist transcription replay",
        },
      });
    }
    const finalized = await finalizeTranscriptionCredits({
      deviceId: user.deviceId,
      requestKey,
      actualSeconds,
      billedModel,
      meta: {
        ...settlementMeta,
        ...buildStoredTranscriptionReplayMeta(storedReplaySuccess),
        pendingFinalize: null,
      },
    });
    if (finalized.ok) {
      reservationActive = false;
    }
    if (!finalized.ok) {
      return respondReplay({
        kind: "error",
        status: finalized.status,
        body: {
          error: finalized.error,
          message: "Failed to finalize transcription billing",
        },
      });
    }
    const durationSummary =
      `${actualSeconds}s`;
    console.log(
      `[transcribe] relay-worker success for device ${user.deviceId} model=${billedModel} provider=${provider} duration=${durationSummary} requestedModel=${requestedModel} qualityMode=${
        typeof qualityMode === "boolean" ? qualityMode : "auto"
      }`
    );

    return respondReplay({
      kind: "success",
      status: 200,
      body: responsePayload,
    });
  } catch (error) {
    console.error("Error creating transcription:", error);

    // Handle cancellation in catch block as well
    if (c.req.raw.signal?.aborted) {
      if (reservationRequestKey) {
        const disposition = await resolveAbortReservationDisposition({
          deviceId: user.deviceId,
          requestKey: reservationRequestKey,
          service: "transcription",
        });
        if (disposition.action === "release") {
          await releaseActiveReservation({
            reason: "route-cancelled-before-relay-ownership",
            message: "outer-route-cancel",
          }).catch(() => {});
          console.warn(
            `[transcribe] released reservation after outer-route cancel before relay ownership for requestKey=${reservationRequestKey}`
          );
        } else {
          console.warn(
            `[transcribe] preserving reservation after outer-route cancel for requestKey=${reservationRequestKey}; relay already owns the request`
          );
        }
      }
      return respondReplay({
        kind: "error",
        status: 408,
        body: { error: "Request cancelled", message: "Request was cancelled" },
      });
    }

    await releaseActiveReservation({
      reason: "route-error",
      message: error instanceof Error ? error.message : String(error),
    }).catch(() => {});

    return respondReplay({
      kind: "error",
      status: 500,
      body: {
        error: "Failed to create transcription",
        message: error instanceof Error ? error.message : "Unknown error",
      },
    });
  } finally {
    stopDirectRequestLeaseHeartbeat?.();
    stopDirectRequestLeaseHeartbeat = null;
  }
});

// ============================================================================
// R2-based Large File Transcription Flow
// ============================================================================

/**
 * TODO(stage5-cleanup): Remove with legacy R2 transcription flow once all
 * clients use the standard worker transcription route (`POST /transcribe`).
 * POST /upload-url
 * Request a presigned URL for uploading a large audio file to R2
 */
router.post("/upload-url", async (c) => {
  const user = c.get("user");

  // Cleanup old jobs in background (non-blocking)
  c.executionCtx.waitUntil(cleanupOldTranscriptionJobs({ maxAgeHours: 24 }));

  try {
    const body = await c.req.json().catch(() => ({}));
    const language = body.language as string | undefined;
    const contentType = body.contentType || "audio/webm";
    const fileSizeMB = body.fileSizeMB as number | undefined;
    const requestedDurationSeconds = parseRequestedDurationSeconds(
      body.durationSeconds ?? body.durationSec
    );

    // Validate file size if provided (max 500MB)
    if (fileSizeMB && fileSizeMB > 500) {
      return c.json(
        {
          error: API_ERRORS.FILE_TOO_LARGE,
          message: "File size exceeds 500MB limit",
        },
        413
      );
    }

    // Check user has credits before allowing upload
    if (user.creditBalance <= 0) {
      return c.json(
        {
          error: API_ERRORS.INSUFFICIENT_CREDITS,
          message: "Insufficient credits",
        },
        402
      );
    }

    // Generate job ID and file key
    const jobId = uuidv4();
    const fileKey = generateFileKey(user.deviceId, jobId);

    // Create R2 client and generate presigned URL
    const r2Client = createR2Client({
      accountId: c.env.R2_ACCOUNT_ID,
      accessKeyId: c.env.R2_ACCESS_KEY_ID,
      secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
    });

    const uploadUrl = await generateUploadUrl(r2Client, fileKey, contentType);

    // Store job in D1 database
    await createTranscriptionJob({
      jobId,
      deviceId: user.deviceId,
      fileKey,
      language,
      durationSeconds: requestedDurationSeconds,
    });

    console.log(
      `[transcribe/upload-url] Created job ${jobId} for device ${user.deviceId}`
    );

    return c.json({
      jobId,
      uploadUrl,
      fileKey,
      expiresIn: 3600, // 1 hour
    });
  } catch (error) {
    console.error("[transcribe/upload-url] Error:", error);
    return c.json(
      {
        error: "Failed to generate upload URL",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

/**
 * TODO(stage5-cleanup): Remove with legacy R2 transcription flow.
 * POST /process/:jobId
 * Start processing a file that was uploaded to R2
 * Uses webhook pattern to ensure results are never lost
 */
router.post("/process/:jobId", async (c) => {
  const user = c.get("user");
  const jobId = c.req.param("jobId");
  const requestKey = buildR2TranscriptionReservationKey(jobId);
  let relayStarted = false;

  try {
    const job = await getTranscriptionJob({ jobId });
    if (!job) {
      return c.json({ error: "Job not found" }, 404);
    }

    if (job.device_id !== user.deviceId) {
      return c.json({ error: "Unauthorized" }, 403);
    }

    const activeReservation = await confirmExistingBillingReservation({
      deviceId: user.deviceId,
      service: "transcription",
      requestKey,
    });
    if (job.status === "pending_upload" && activeReservation.ok) {
      return c.json(
        { error: "Job already processing or completed", status: "processing" },
        400
      );
    }

    if (job.status !== "pending_upload") {
      return c.json(
        { error: "Job already processing or completed", status: job.status },
        400
      );
    }

    // Verify file exists in R2
    const r2Object = await c.env.TRANSCRIPTION_BUCKET.head(job.file_key!);
    if (!r2Object) {
      return c.json(
        { error: "File not found in storage. Please upload first." },
        400
      );
    }

    // Generate a download URL for the relay to fetch the file
    const r2Client = createR2Client({
      accountId: c.env.R2_ACCOUNT_ID,
      accessKeyId: c.env.R2_ACCESS_KEY_ID,
      secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
    });
    const downloadUrl = await generateDownloadUrl(r2Client, job.file_key!);

    // Build the webhook URL for the relay to call when done
    // The relay will POST the result to this URL, avoiding Worker timeout issues
    const webhookUrl = `${STAGE5_API_BASE_URL}/transcribe/webhook/${jobId}`;

    console.log(
      `[transcribe/process] Starting processing for job ${jobId} (${(
        r2Object.size /
        1024 /
        1024
      ).toFixed(1)}MB) with webhook callback`
    );

    const reserveSeconds = resolveInitialReservationSeconds({
      requestedDurationSeconds: job.duration_seconds,
      fileSizeBytes: r2Object.size,
    });
    const reserved = await reserveTranscriptionCredits({
      deviceId: user.deviceId,
      requestKey,
      reserveSeconds,
      reserveModel: STAGE5_ELEVENLABS_SCRIBE_MODEL,
      meta: {
        source: "r2",
        jobId,
        fileSizeBytes: r2Object.size,
        requestedDurationSeconds: job.duration_seconds,
      },
    });
    if (!reserved.ok) {
      return c.json({ error: API_ERRORS.INSUFFICIENT_CREDITS }, 402);
    }
    if (reserved.status === "duplicate") {
      return c.json(
        {
          error: "Job already processing or completed",
          status:
            reserved.reservationStatus === "settled" ? "completed" : "processing",
        },
        409
      );
    }

    // Call relay with webhook URL - relay returns immediately
    // When transcription completes, relay will POST to webhookUrl
    try {
      await callElevenLabsTranscribeFromR2({
        c,
        r2Url: downloadUrl,
        language: job.language ?? undefined,
        webhookUrl,
        webhookToken: buildR2TranscriptionWebhookToken({
          jobId,
          relaySecret: c.env.RELAY_SECRET,
        }),
        deviceId: user.deviceId,
        requestKey,
      });
      relayStarted = true;
    } catch (relayError) {
      await releaseTranscriptionReservation({
        deviceId: user.deviceId,
        requestKey,
        meta: { reason: "r2-relay-start-failed", jobId },
      });
      throw relayError;
    }

    try {
      await setTranscriptionJobProcessing({ jobId });
    } catch (statusError) {
      console.warn(
        `[transcribe/process] Relay started for job ${jobId}, but failed to persist processing status: ${
          statusError instanceof Error ? statusError.message : String(statusError)
        }`
      );
    }

    return c.json({
      jobId: job.job_id,
      status: "processing",
      message: "Processing started",
    });
  } catch (error) {
    console.error("[transcribe/process] Error:", error);
    if (!relayStarted) {
      await releaseTranscriptionReservation({
        deviceId: user.deviceId,
        requestKey,
        meta: { reason: "process-route-error" },
      }).catch(() => {});
    }
    return c.json(
      {
        error: "Failed to start processing",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

/**
 * TODO(stage5-cleanup): Remove with legacy R2 transcription flow.
 * GET /status/:jobId
 * Check the status of a transcription job
 */
router.get("/status/:jobId", async (c) => {
  const user = c.get("user");
  const jobId = c.req.param("jobId");

  const job = await getTranscriptionJob({ jobId });
  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  if (job.device_id !== user.deviceId) {
    return c.json({ error: "Unauthorized" }, 403);
  }

  if (job.status === "completed") {
    // Parse and return the result
    const result = job.result ? JSON.parse(job.result) : null;
    return c.json({
      jobId: job.job_id,
      status: job.status,
      result,
    });
  }

  if (job.status === "failed") {
    return c.json({
      jobId: job.job_id,
      status: job.status,
      error: job.error,
    });
  }

  return c.json({
    jobId: job.job_id,
    status: job.status,
  });
});

export default router;

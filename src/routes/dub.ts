import { Hono, Context } from "hono";
import crypto from "node:crypto";
import { z } from "zod";
import {
  ALLOWED_SPEECH_MODELS,
  ALLOWED_SPEECH_VOICES,
  ALLOWED_SPEECH_FORMATS,
  API_ERRORS,
  DEFAULT_SPEECH_MODEL,
  HIGH_QUALITY_SPEECH_MODEL,
  DEFAULT_SPEECH_VOICE,
  DEFAULT_SPEECH_FORMAT,
  SpeechFormat,
} from "../lib/constants";
import {
  reserveBillingCredits,
  releaseBillingReservation,
  settleBillingReservation,
} from "../lib/db";
import {
  callDubRelay,
  callSpeechDirect,
  callElevenLabsDubRelay,
} from "../lib/openai-config";
import { STAGE5_TTS_MODEL_ELEVEN_V3 } from "../lib/model-catalog";
import { type TTSModel, estimateDubbingCredits } from "../lib/pricing";
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
  persistDirectReplayOrRelease,
  recoverOrRestartDuplicateReservation,
  startDirectRequestLeaseHeartbeat,
} from "../lib/direct-request-recovery";
import { bearerAuth, type AuthVariables } from "../lib/middleware";
import {
  buildScopedIdempotencyKey,
  getRequestIdempotencyKey,
} from "../lib/request-utils";
import type { Stage5ApiBindings } from "../types/env";

const MAX_SCRIPT_CHARACTERS = 200_000;
const MAX_TOTAL_SEGMENT_CHARACTERS = 80_000;
const MAX_SEGMENTS_PER_REQUEST = 240;
const ELEVENLABS_TTS_MAX_TEXT_CHARACTERS = 5_000;
const FALLBACK_SEGMENT_CONCURRENCY = 4;
const HD_ONLY_VOICES = new Set<string>();
const DUB_RESERVATION_SCOPE = "dub-billing-v2";
const DUB_REPLAY_TTL_MS = Math.max(
  1_000,
  Number.parseInt(process.env.DUB_REPLAY_TTL_MS || String(10 * 60 * 1_000), 10),
);
const dubReplayCache = new Map<string, JsonReplayEntry>();

function normalizeSegmentText(raw?: string | null): string {
  if (!raw) {
    return "";
  }

  const withoutCues = raw
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\r?\n/g, " ");

  const collapsed = withoutCues.replace(/\s+/g, " ").trim();

  if (!collapsed) {
    return "";
  }

  // Require at least one letter to avoid emitting timestamp/index lines.
  if (!/\p{L}/u.test(collapsed)) {
    return "";
  }

  return collapsed;
}

function buildDubReservationKey({
  requestIdempotencyKey,
  payload,
}: {
  requestIdempotencyKey?: string;
  payload: unknown;
}): string {
  return (
    buildScopedIdempotencyKey({
      scope: DUB_RESERVATION_SCOPE,
      requestIdempotencyKey,
      payload,
    }) || `${DUB_RESERVATION_SCOPE}:${crypto.randomUUID()}`
  );
}

function buildDuplicateDirectDubResponse({
  reservationStatus,
  replayResult,
}: {
  reservationStatus: "reserved" | "settled" | "released";
  replayResult: JsonReplayResult | null;
}): JsonReplayResult {
  if (reservationStatus === "settled" && replayResult) {
    return replayResult;
  }

  return {
    kind: "error",
    status: 409,
    body: {
      error: "duplicate-request-in-progress",
      message:
        "A dub request with this idempotency key is already in progress.",
    },
  };
}

function buildStoredDubReplayMeta(
  storedReplay: StoredJsonReplayResult | null,
): Record<string, unknown> {
  if (!storedReplay) {
    return {};
  }
  return {
    directReplayResult: storedReplay,
  };
}

async function loadStoredDubReplay({
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

type PendingDirectDubFinalize = {
  actualSpend: number;
  settlementMeta: Record<string, unknown>;
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function extractPendingDirectDubFinalize(
  reservationMeta: unknown,
): PendingDirectDubFinalize | null {
  const metaObject = asObject(reservationMeta);
  const pendingObject = asObject(metaObject?.pendingFinalize);
  const settlementMeta = asObject(pendingObject?.settlementMeta);
  const actualSpend = Number(pendingObject?.actualSpend);
  if (!settlementMeta || !Number.isFinite(actualSpend) || actualSpend < 0) {
    return null;
  }

  return {
    actualSpend,
    settlementMeta,
  };
}

async function resolveDuplicateDirectDubReservation({
  bucket,
  deviceId,
  requestKey,
  reservation,
}: {
  bucket: R2Bucket;
  deviceId: string;
  requestKey: string;
  reservation: {
    status: "reserved" | "settled" | "released";
    meta: string | null;
    updatedAt: string | null;
  };
}): Promise<
  | { action: "retry-reserve" }
  | { action: "respond"; replay: JsonReplayResult; cacheSuccess?: boolean }
> {
  const storedReplay = extractStoredJsonReplayEnvelope(
    parseReplayMeta(reservation.meta),
  );
  const replayResult = await loadStoredDubReplay({
    bucket,
    storedReplay,
  });
  if (reservation.status === "released") {
    return { action: "retry-reserve" };
  }
  if (reservation.status === "settled" && replayResult) {
    return {
      action: "respond",
      replay: replayResult,
      cacheSuccess: replayResult.kind === "success",
    };
  }

  const pendingFinalize = extractPendingDirectDubFinalize(
    parseReplayMeta(reservation.meta),
  );
  if (replayResult && pendingFinalize) {
    const settled = await settleBillingReservation({
      deviceId,
      service: "tts",
      requestKey,
      actualSpend: pendingFinalize.actualSpend,
      reason: "DUB",
      meta: {
        ...pendingFinalize.settlementMeta,
        ...buildStoredDubReplayMeta(storedReplay),
        pendingFinalize: null,
      },
    });
    if (settled.ok) {
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
        status: settled.error === "actual-spend-exceeds-reserve" ? 409 : 500,
        body: {
          error: settled.error,
          message: "Failed to finalize dubbing billing",
        },
      },
    };
  }

  const recovery = await recoverOrRestartDuplicateReservation({
    deviceId,
    requestKey,
    service: "tts",
    reservation: {
      status: reservation.status,
      meta: reservation.meta,
      updated_at: reservation.updatedAt,
    },
    releaseReason: "DUB",
    releaseMeta: {
      recoveryReason: "stale-direct-dub-retry",
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
    parseReplayMeta(recovery.reservationMeta),
  );
  const settledReplay = await loadStoredDubReplay({
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
    replay: buildDuplicateDirectDubResponse({
      reservationStatus: "settled",
      replayResult: settledReplay,
    }),
  };
}

const segmentSchema = z.object({
  start: z.number().optional(),
  end: z.number().optional(),
  original: z.string().optional(),
  translation: z.string().optional(),
  index: z.number().optional(),
});

const requestSchema = z.object({
  segments: z.array(segmentSchema).min(1),
  voice: z.string().optional(),
  targetLanguage: z.string().optional(),
  model: z.string().optional(),
  format: z.string().optional(),
  quality: z.enum(["standard", "high"]).optional(),
  // TTS provider selection: "openai" (cheaper) or "elevenlabs" (higher quality, more expensive)
  ttsProvider: z.enum(["openai", "elevenlabs"]).optional(),
});

const router = new Hono<{
  Bindings: Stage5ApiBindings;
  Variables: AuthVariables;
}>();

// Use shared auth middleware
router.use("*", bearerAuth());

/**
 * POST /estimate
 * Get estimated credit cost for a dubbing job before starting
 * Helps users understand costs and choose provider
 */
router.post("/estimate", async (c) => {
  try {
    const body = await c.req.json();
    const characters = body.characters as number;

    if (typeof characters !== "number" || characters <= 0) {
      return c.json({ error: "Invalid character count" }, 400);
    }

    // Calculate estimates for both providers
    const openaiEstimate = estimateDubbingCredits({
      characters,
      model: DEFAULT_SPEECH_MODEL,
    });
    const openaiHdEstimate = estimateDubbingCredits({
      characters,
      model: HIGH_QUALITY_SPEECH_MODEL,
    });
    const elevenLabsEstimate = estimateDubbingCredits({
      characters,
      model: STAGE5_TTS_MODEL_ELEVEN_V3,
    });

    return c.json({
      characters,
      estimates: {
        openai: {
          model: DEFAULT_SPEECH_MODEL,
          credits: openaiEstimate.credits,
          usdCost: openaiEstimate.usdEstimate,
          description: "OpenAI TTS - Good quality, most affordable",
        },
        openaiHd: {
          model: HIGH_QUALITY_SPEECH_MODEL,
          credits: openaiHdEstimate.credits,
          usdCost: openaiHdEstimate.usdEstimate,
          description: "OpenAI TTS HD - Higher quality audio",
        },
        elevenlabs: {
          model: STAGE5_TTS_MODEL_ELEVEN_V3,
          credits: elevenLabsEstimate.credits,
          usdCost: elevenLabsEstimate.usdEstimate,
          description: "ElevenLabs v3 - Premium quality, most expressive",
        },
      },
    });
  } catch (error: any) {
    return c.json({ error: error?.message || "Failed to estimate" }, 500);
  }
});

router.post("/", async (c) => {
  const user = c.get("user");
  const requestIdempotencyKey = getRequestIdempotencyKey(c);
  let reservationRequestKey: string | null = null;
  let reservationActive = false;
  let stopDirectRequestLeaseHeartbeat: (() => void) | null = null;
  let replayContext: { requestKey: string; entry: JsonReplayEntry } | null =
    null;
  const respondReplay = (
    replay: JsonReplayResult,
    cacheSuccess = replay.kind === "success",
  ) => {
    if (replayContext) {
      settleJsonReplayEntry({
        cache: dubReplayCache,
        requestKey: replayContext.requestKey,
        entry: replayContext.entry,
        result: replay,
        ttlMs: DUB_REPLAY_TTL_MS,
        cacheSuccess,
      });
    }
    return c.json(replay.body as any, replay.status as any);
  };

  try {
    if (c.req.raw.signal?.aborted) {
      return c.json(
        { error: "Request cancelled", message: "Request was cancelled" },
        408,
      );
    }

    const body = await c.req.json();
    const parsed = requestSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          error: API_ERRORS.INVALID_REQUEST,
          details: parsed.error.flatten(),
        },
        400,
      );
    }

    const { segments, voice, model, format, quality, ttsProvider } =
      parsed.data;

    // Default to OpenAI (cheaper) if not specified
    const chosenTtsProvider = ttsProvider ?? "openai";

    type RelaySegment = {
      index: number;
      text: string;
      start?: number;
      end?: number;
      targetDuration?: number;
    };

    const sanitizedSegments: RelaySegment[] = [];
    segments.forEach((seg, idx) => {
      const translation =
        typeof seg.translation === "string" ? seg.translation.trim() : "";
      const original =
        typeof seg.original === "string" ? seg.original.trim() : "";
      const fallback = translation || original;
      const text = normalizeSegmentText(fallback);
      if (!text) {
        return;
      }

      const start =
        typeof seg.start === "number" && Number.isFinite(seg.start)
          ? seg.start
          : undefined;
      const end =
        typeof seg.end === "number" && Number.isFinite(seg.end)
          ? seg.end
          : undefined;
      const targetDurationExplicit =
        typeof (seg as any).targetDuration === "number" &&
        Number.isFinite((seg as any).targetDuration) &&
        (seg as any).targetDuration > 0
          ? (seg as any).targetDuration
          : undefined;
      const targetDuration =
        targetDurationExplicit ??
        (typeof start === "number" && typeof end === "number" && end > start
          ? end - start
          : undefined);

      sanitizedSegments.push({
        index:
          typeof seg.index === "number" && Number.isFinite(seg.index)
            ? seg.index
            : idx + 1,
        text,
        start,
        end,
        targetDuration,
      });
    });

    if (chosenTtsProvider === "elevenlabs") {
      const oversizedSegment = sanitizedSegments.find(
        (segment) => segment.text.length > ELEVENLABS_TTS_MAX_TEXT_CHARACTERS,
      );
      if (oversizedSegment) {
        return c.json(
          {
            error: API_ERRORS.INVALID_REQUEST,
            message: `Segment ${oversizedSegment.index} has ${oversizedSegment.text.length} characters. ElevenLabs v3 accepts at most ${ELEVENLABS_TTS_MAX_TEXT_CHARACTERS} characters per segment.`,
          },
          413,
        );
      }
    }

    const totalCharacters = sanitizedSegments.reduce(
      (sum, seg) => sum + seg.text.length,
      0,
    );
    if (totalCharacters > MAX_TOTAL_SEGMENT_CHARACTERS) {
      return c.json(
        {
          error: API_ERRORS.INVALID_REQUEST,
          message: `Dub request includes ${totalCharacters} characters (max ${MAX_TOTAL_SEGMENT_CHARACTERS}). Please split the job into smaller batches.`,
        },
        413,
      );
    }

    if (sanitizedSegments.length > MAX_SEGMENTS_PER_REQUEST) {
      return c.json(
        {
          error: API_ERRORS.INVALID_REQUEST,
          message: `Dub request contains ${sanitizedSegments.length} segments (max ${MAX_SEGMENTS_PER_REQUEST}). Reduce the number of segments and retry.`,
        },
        413,
      );
    }

    const textLines = sanitizedSegments.map((seg) => seg.text);

    if (!textLines.length) {
      return c.json(
        {
          error: API_ERRORS.INVALID_REQUEST,
          message: "No text available for dubbing",
        },
        400,
      );
    }

    const script = textLines.join("\n");
    if (script.length > MAX_SCRIPT_CHARACTERS) {
      return c.json(
        {
          error: API_ERRORS.INVALID_REQUEST,
          message: `Script exceeds ${MAX_SCRIPT_CHARACTERS} characters`,
        },
        413,
      );
    }

    const chosenVoice =
      voice && ALLOWED_SPEECH_VOICES.includes(voice)
        ? voice
        : DEFAULT_SPEECH_VOICE;
    const prefersHd = HD_ONLY_VOICES.has(chosenVoice);

    let chosenModel =
      model && ALLOWED_SPEECH_MODELS.includes(model)
        ? model
        : quality === "high" || prefersHd
          ? HIGH_QUALITY_SPEECH_MODEL
          : DEFAULT_SPEECH_MODEL;

    if (prefersHd && chosenModel !== HIGH_QUALITY_SPEECH_MODEL) {
      chosenModel = HIGH_QUALITY_SPEECH_MODEL;
    }
    const normalizedFormat = format?.toLowerCase() as SpeechFormat | undefined;
    const chosenFormat: SpeechFormat =
      normalizedFormat && ALLOWED_SPEECH_FORMATS.includes(normalizedFormat)
        ? normalizedFormat
        : DEFAULT_SPEECH_FORMAT;
    const reserveModel: TTSModel =
      chosenTtsProvider === "elevenlabs"
        ? STAGE5_TTS_MODEL_ELEVEN_V3
        : chosenModel === HIGH_QUALITY_SPEECH_MODEL
          ? HIGH_QUALITY_SPEECH_MODEL
          : DEFAULT_SPEECH_MODEL;
    const reservationPayload = {
      deviceId: user.deviceId,
      voice: chosenVoice,
      model: chosenModel,
      reserveModel,
      format: chosenFormat,
      quality: quality ?? "standard",
      ttsProvider: chosenTtsProvider,
      segments: sanitizedSegments.map((segment) => ({
        index: segment.index,
        text: segment.text,
        start: segment.start ?? null,
        end: segment.end ?? null,
        targetDuration: segment.targetDuration ?? null,
      })),
    };
    const requestKey = buildDubReservationKey({
      requestIdempotencyKey,
      payload: reservationPayload,
    });
    const directRequestLease = createDirectRequestLease();
    reservationRequestKey = requestKey;
    pruneJsonReplayCache(dubReplayCache);
    const existingReplay = dubReplayCache.get(requestKey);
    if (existingReplay) {
      const replay = existingReplay.result ?? (await existingReplay.promise);
      return c.json(replay.body as any, replay.status as any);
    }
    const replayEntry = createJsonReplayEntry();
    dubReplayCache.set(requestKey, replayEntry);
    replayContext = { requestKey, entry: replayEntry };
    const reserveSpend = estimateDubbingCredits({
      characters: totalCharacters,
      model: reserveModel,
    }).credits;
    let reserved: Awaited<ReturnType<typeof reserveBillingCredits>> | null =
      null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      reserved = await reserveBillingCredits({
        deviceId: user.deviceId,
        service: "tts",
        requestKey,
        spend: reserveSpend,
        reason: "DUB_RESERVE",
        meta: {
          ...reservationPayload,
          totalCharacters,
          reserveSpend,
          directRequestLease,
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
      if (
        reserved.reservation.status !== "reserved" &&
        reserved.reservation.status !== "settled" &&
        reserved.reservation.status !== "released"
      ) {
        throw new Error(
          `Unexpected duplicate dub reservation status: ${reserved.reservation.status}`,
        );
      }

      const duplicateResolution = await resolveDuplicateDirectDubReservation({
        bucket: c.env.TRANSCRIPTION_BUCKET,
        deviceId: user.deviceId,
        requestKey,
        reservation: {
          status: reserved.reservation.status,
          meta: reserved.reservation.meta,
          updatedAt: reserved.reservation.updated_at,
        },
      });
      if (duplicateResolution.action === "respond") {
        return respondReplay(
          duplicateResolution.replay,
          duplicateResolution.cacheSuccess,
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
            "A dub request with this idempotency key is already in progress.",
        },
      });
    }
    reservationActive = true;
    stopDirectRequestLeaseHeartbeat = startDirectRequestLeaseHeartbeat({
      deviceId: user.deviceId,
      requestKey,
      service: "tts",
      lease: directRequestLease,
    });

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 300000);
    c.req.raw.signal?.addEventListener("abort", () => {
      clearTimeout(timeoutId);
      abortController.abort();
    });

    type SynthResult = Awaited<ReturnType<typeof synthesizeDubWithFallback>>;
    let relayResult: SynthResult | null = null;

    try {
      relayResult = await synthesizeDubWithFallback({
        c,
        sanitizedSegments,
        lines: textLines,
        voice: chosenVoice,
        model: chosenModel,
        format: chosenFormat,
        signal: abortController.signal,
        ttsProvider: chosenTtsProvider,
        deviceId: user.deviceId,
        requestKey,
      });
    } catch (synthesisError: any) {
      clearTimeout(timeoutId);
      if (abortController.signal.aborted) {
        const wasCancelled = c.req.raw.signal?.aborted;
        console.warn(
          `[dub] preserving reservation after ${
            wasCancelled ? "client cancel" : "timeout"
          } for requestKey=${requestKey}; retry will reuse or stale-recover the existing lease`,
        );
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

      await releaseBillingReservation({
        deviceId: user.deviceId,
        service: "tts",
        requestKey,
        reason: "DUB",
        meta: {
          reason: "synthesis-error",
          message: synthesisError?.message || String(synthesisError),
        },
      });
      reservationActive = false;

      throw synthesisError;
    } finally {
      clearTimeout(timeoutId);
    }

    if (
      !relayResult ||
      (!relayResult.audioBase64 && !relayResult.segments?.length)
    ) {
      await releaseBillingReservation({
        deviceId: user.deviceId,
        service: "tts",
        requestKey,
        reason: "DUB",
        meta: { reason: "empty-audio-result" },
      });
      reservationActive = false;
      throw new Error("Dub synthesis returned no audio segments");
    }

    const approxSeconds = segments.reduce((sum, seg) => {
      const start = typeof seg.start === "number" ? seg.start : 0;
      const end = typeof seg.end === "number" ? seg.end : start;
      const delta = end - start;
      return sum + (Number.isFinite(delta) && delta > 0 ? delta : 0);
    }, 0);

    const usedRelay = relayResult.usedRelay;

    // Determine TTS model for pricing based on provider and what was actually used
    let ttsModelForPricing: TTSModel;
    if (relayResult.usedElevenLabs) {
      ttsModelForPricing = STAGE5_TTS_MODEL_ELEVEN_V3;
    } else if (chosenModel === HIGH_QUALITY_SPEECH_MODEL) {
      ttsModelForPricing = HIGH_QUALITY_SPEECH_MODEL;
    } else {
      ttsModelForPricing = DEFAULT_SPEECH_MODEL;
    }

    const actualSpend = estimateDubbingCredits({
      characters: totalCharacters,
      model: ttsModelForPricing,
    }).credits;
    const segmentCount =
      relayResult.segmentCount ?? relayResult.segments?.length ?? 0;
    const responsePayload = {
      audioBase64: relayResult.audioBase64,
      segments: relayResult.segments,
      voice: relayResult.voice ?? chosenVoice,
      model: relayResult.usedElevenLabs
        ? STAGE5_TTS_MODEL_ELEVEN_V3
        : (relayResult.model ?? chosenModel),
      format: relayResult.format ?? chosenFormat,
      totalCharacters,
      approxSeconds,
      usedRelay,
      usedElevenLabs: relayResult.usedElevenLabs ?? false,
      chunkCount: relayResult.chunkCount ?? (segmentCount || undefined),
      segmentCount,
    };
    const replaySuccess: JsonReplayResult = {
      kind: "success",
      status: 200,
      body: responsePayload,
    };
    const settlementMeta = {
      approxSeconds,
      usedRelay,
      ttsProvider: chosenTtsProvider,
      openaiModel: chosenModel,
      quality: quality ?? "standard",
      totalCharacters,
      billedModel: ttsModelForPricing,
    };
    const pendingFinalize: PendingDirectDubFinalize = {
      actualSpend,
      settlementMeta,
    };
    const storedReplaySuccess = await storeSuccessJsonReplayArtifact({
      bucket: c.env.TRANSCRIPTION_BUCKET,
      service: "tts",
      deviceId: user.deviceId,
      requestKey,
      replay: replaySuccess,
    });
    const persistResult = await persistDirectReplayOrRelease({
      deviceId: user.deviceId,
      requestKey,
      service: "tts",
      replayResult: storedReplaySuccess,
      pendingFinalize,
      releaseReason: "DUB",
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
          message: persistResult.details || "Failed to persist dub replay",
        },
      });
    }
    const settled = await settleBillingReservation({
      deviceId: user.deviceId,
      service: "tts",
      requestKey,
      actualSpend,
      reason: "DUB",
      meta: {
        ...settlementMeta,
        actualSpend,
        ...buildStoredDubReplayMeta(storedReplaySuccess),
        pendingFinalize: null,
      },
    });
    if (settled.ok) {
      reservationActive = false;
    }

    if (!settled.ok) {
      return respondReplay({
        kind: "error",
        status: settled.error === "actual-spend-exceeds-reserve" ? 409 : 500,
        body: { error: settled.error },
      });
    }

    console.log(
      `[dub] success for ${user.deviceId} provider=${
        relayResult.usedElevenLabs ? "elevenlabs" : "openai"
      } chars=${totalCharacters} segments=${segmentCount}`,
    );

    return respondReplay({
      kind: "success",
      status: 200,
      body: responsePayload,
    });
  } catch (error: any) {
    console.error("Error generating dub:", error);

    if (c.req.raw.signal?.aborted) {
      console.warn(
        `[dub] preserving reservation after outer-route cancel for requestKey=${reservationRequestKey ?? "unknown"}; retry will reuse or stale-recover the existing lease`,
      );
      return respondReplay({
        kind: "error",
        status: 408,
        body: { error: "Request cancelled", message: "Request was cancelled" },
      });
    }

    if (reservationRequestKey && reservationActive) {
      await releaseBillingReservation({
        deviceId: user.deviceId,
        service: "tts",
        requestKey: reservationRequestKey,
        reason: "DUB",
        meta: { reason: "route-error" },
      }).catch(() => {});
      reservationActive = false;
    }

    return respondReplay({
      kind: "error",
      status: 500,
      body: {
        error: "Failed to generate dub",
        message: error?.message || "Unknown error",
      },
    });
  } finally {
    stopDirectRequestLeaseHeartbeat?.();
    stopDirectRequestLeaseHeartbeat = null;
  }
});

export default router;

const RETRYABLE_RELAY_STATUS = new Set([
  408, 409, 425, 429, 500, 502, 503, 504, 522, 524,
]);
const RETRYABLE_MESSAGE_PATTERN =
  /(timeout|timed out|temporarily unavailable|connection reset|gateway|rate limit|fetch failed)/i;

function extractRelayStatus(error: unknown): number | null {
  const message =
    typeof error === "string" ? error : String((error as any)?.message ?? "");
  const match = message.match(/Dub relay server error:\s*(\d{3})/i);
  if (match) {
    return Number(match[1]);
  }
  const status = (error as any)?.status ?? (error as any)?.response?.status;
  return typeof status === "number" ? status : null;
}

function isRetryableRelayError(error: unknown): boolean {
  const status = extractRelayStatus(error);
  if (status != null && status >= 200 && status < 400) {
    return false;
  }
  if (status != null && RETRYABLE_RELAY_STATUS.has(status)) {
    return true;
  }
  const message =
    typeof error === "string" ? error : String((error as any)?.message ?? "");
  if (RETRYABLE_MESSAGE_PATTERN.test(message)) {
    return true;
  }
  const code = (error as any)?.code;
  if (typeof code === "string") {
    const normalized = code.toUpperCase();
    if (
      [
        "ETIMEDOUT",
        "ECONNRESET",
        "ECONNREFUSED",
        "EHOSTUNREACH",
        "ENETUNREACH",
      ].includes(normalized)
    ) {
      return true;
    }
  }
  return status == null; // network / unknown errors - treat as retryable
}

interface SynthRequest {
  c: Context;
  sanitizedSegments: Array<{
    index: number;
    text: string;
    start?: number;
    end?: number;
    targetDuration?: number;
  }>;
  lines: string[];
  voice: string;
  model: string;
  format: SpeechFormat;
  signal: AbortSignal;
  ttsProvider: "openai" | "elevenlabs";
  deviceId: string;
  requestKey: string;
}

interface SynthResult {
  audioBase64?: string;
  voice?: string;
  model?: string;
  format?: SpeechFormat;
  chunkCount?: number;
  segmentCount?: number;
  segments?: Array<{
    index: number;
    audioBase64: string;
    targetDuration?: number;
  }>;
  usedRelay: boolean;
  usedElevenLabs: boolean;
}

async function synthesizeDubWithFallback({
  c,
  sanitizedSegments,
  lines,
  voice,
  model,
  format,
  signal,
  ttsProvider,
  deviceId,
  requestKey,
}: SynthRequest): Promise<SynthResult> {
  // Route based on user's provider preference
  if (ttsProvider === "elevenlabs") {
    // Try ElevenLabs first, fall back to OpenAI
    try {
      const elevenLabsResponse = await callElevenLabsDubRelay({
        c,
        segments: sanitizedSegments,
        voice,
        format,
        signal,
        deviceId,
        requestKey,
      });
      console.log(
        `[dub] ElevenLabs TTS succeeded, segments=${sanitizedSegments.length}`,
      );
      return {
        ...elevenLabsResponse,
        format: (elevenLabsResponse.format as SpeechFormat) || "mp3",
        usedRelay: true,
        usedElevenLabs: true,
      };
    } catch (elevenLabsError: any) {
      if (signal.aborted) {
        throw elevenLabsError;
      }

      console.warn(
        `[dub] ElevenLabs failed (${
          elevenLabsError?.message || elevenLabsError
        }); trying OpenAI relay...`,
      );

      // Fall back to OpenAI relay
      return synthesizeWithOpenAI({
        c,
        sanitizedSegments,
        lines,
        voice,
        model,
        format,
        signal,
        deviceId,
        requestKey,
      });
    }
  } else {
    // OpenAI provider - use OpenAI directly, no ElevenLabs fallback
    return synthesizeWithOpenAI({
      c,
      sanitizedSegments,
      lines,
      voice,
      model,
      format,
      signal,
      deviceId,
      requestKey,
    });
  }
}

async function synthesizeWithOpenAI({
  c,
  sanitizedSegments,
  lines,
  voice,
  model,
  format,
  signal,
  deviceId,
  requestKey,
}: Omit<SynthRequest, "ttsProvider">): Promise<SynthResult> {
  try {
    const relayResponse = await callDubRelay({
      c,
      lines,
      segments: sanitizedSegments,
      voice,
      model,
      format,
      signal,
      deviceId,
      requestKey,
    });
    return { ...relayResponse, usedRelay: true, usedElevenLabs: false };
  } catch (relayError: any) {
    if (signal.aborted) {
      throw relayError;
    }

    if (!isRetryableRelayError(relayError)) {
      throw relayError;
    }

    console.warn(
      `[dub] OpenAI relay failed (${
        relayError?.message || relayError
      }); falling back to direct. segments=${sanitizedSegments.length}`,
    );

    // Fall back to direct OpenAI
    const fallbackSegments = await synthesizeSegmentsDirect({
      c,
      segments: sanitizedSegments,
      voice,
      model,
      format,
      signal,
    });

    return {
      voice,
      model,
      format,
      segmentCount: fallbackSegments.length,
      segments: fallbackSegments,
      usedRelay: false,
      usedElevenLabs: false,
    };
  }
}

async function synthesizeSegmentsDirect({
  c,
  segments,
  voice,
  model,
  format,
  signal,
}: {
  c: Context;
  segments: Array<{
    index: number;
    text: string;
    targetDuration?: number;
  }>;
  voice: string;
  model: string;
  format: SpeechFormat;
  signal: AbortSignal;
}): Promise<
  Array<{ index: number; audioBase64: string; targetDuration?: number }>
> {
  if (signal.aborted) {
    throw new DOMException("Operation cancelled", "AbortError");
  }

  const results: Array<{
    index: number;
    audioBase64: string;
    targetDuration?: number;
  }> = [];
  const errors: unknown[] = [];
  let cursor = 0;

  const maxConcurrency = Math.max(
    1,
    Math.min(FALLBACK_SEGMENT_CONCURRENCY, segments.length),
  );

  const claimNextSegmentIndex = (): number | null => {
    if (signal.aborted || errors.length > 0 || cursor >= segments.length) {
      return null;
    }
    const currentIndex = cursor;
    cursor += 1;
    return currentIndex;
  };

  const workers = Array.from({ length: maxConcurrency }, async () => {
    for (
      let currentIndex = claimNextSegmentIndex();
      currentIndex !== null;
      currentIndex = claimNextSegmentIndex()
    ) {
      const seg = segments[currentIndex];
      try {
        const direct = await callSpeechDirect({
          c,
          text: seg.text,
          voice,
          model,
          format,
          signal,
        });

        results.push({
          index: seg.index,
          audioBase64: direct.audioBase64,
          targetDuration: seg.targetDuration,
        });
      } catch (err) {
        errors.push(err);
        return;
      }
    }
  });

  await Promise.all(workers);

  if (errors.length) {
    throw errors[0];
  }

  results.sort((a, b) => a.index - b.index);
  return results;
}

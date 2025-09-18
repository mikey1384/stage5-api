import { Hono, Next } from "hono";
import { cors } from "hono/cors";
import { Context } from "hono";
import { z } from "zod";
import {
  ALLOWED_SPEECH_MODELS,
  ALLOWED_SPEECH_VOICES,
  ALLOWED_SPEECH_FORMATS,
  API_ERRORS,
  DEFAULT_SPEECH_MODEL,
  DEFAULT_SPEECH_VOICE,
  DEFAULT_SPEECH_FORMAT,
  SpeechFormat,
} from "../lib/constants";
import { getUserByApiKey, deductSpeechCredits } from "../lib/db";
import { callDubRelay, callSpeechDirect } from "../lib/openai-config";

const MAX_SCRIPT_CHARACTERS = 200_000;
const MAX_TOTAL_SEGMENT_CHARACTERS = 80_000;
const MAX_SEGMENTS_PER_REQUEST = 240;
const FALLBACK_SEGMENT_CONCURRENCY = 4;
const HD_ONLY_VOICES = new Set<string>();

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
});

type Bindings = {
  OPENAI_API_KEY: string;
  RELAY_SECRET: string;
  DB: D1Database;
};

type Variables = {
  user: {
    deviceId: string;
    creditBalance: number;
  };
};

const router = new Hono<{ Bindings: Bindings; Variables: Variables }>();

router.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

router.options(
  "*",
  () =>
    new Response("", {
      status: 204,
      headers: { "Content-Type": "text/plain" },
    })
);

router.use("*", async (c: Context, next: Next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json(
      { error: API_ERRORS.UNAUTHORIZED, message: "Missing API key" },
      401
    );
  }

  const apiKey = authHeader.substring(7);
  const user = await getUserByApiKey({ apiKey });

  if (!user) {
    return c.json(
      { error: API_ERRORS.UNAUTHORIZED, message: "Invalid API key" },
      401
    );
  }

  c.set("user", {
    deviceId: user.device_id,
    creditBalance: user.credit_balance,
  });

  await next();
});

router.post("/", async (c) => {
  const user = c.get("user");

  try {
    if (c.req.raw.signal?.aborted) {
      return c.json(
        { error: "Request cancelled", message: "Request was cancelled" },
        408
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
        400
      );
    }

    const { segments, voice, model, format, quality } = parsed.data;

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

    const totalCharacters = sanitizedSegments.reduce(
      (sum, seg) => sum + seg.text.length,
      0
    );
    if (totalCharacters > MAX_TOTAL_SEGMENT_CHARACTERS) {
      return c.json(
        {
          error: API_ERRORS.INVALID_REQUEST,
          message: `Dub request includes ${totalCharacters} characters (max ${MAX_TOTAL_SEGMENT_CHARACTERS}). Please split the job into smaller batches.`,
        },
        413
      );
    }

    if (sanitizedSegments.length > MAX_SEGMENTS_PER_REQUEST) {
      return c.json(
        {
          error: API_ERRORS.INVALID_REQUEST,
          message: `Dub request contains ${sanitizedSegments.length} segments (max ${MAX_SEGMENTS_PER_REQUEST}). Reduce the number of segments and retry.`,
        },
        413
      );
    }

    const textLines = sanitizedSegments.map(seg => seg.text);

    if (!textLines.length) {
      return c.json(
        {
          error: API_ERRORS.INVALID_REQUEST,
          message: "No text available for dubbing",
        },
        400
      );
    }

    const script = textLines.join("\n");
    if (script.length > MAX_SCRIPT_CHARACTERS) {
      return c.json(
        {
          error: API_ERRORS.INVALID_REQUEST,
          message: `Script exceeds ${MAX_SCRIPT_CHARACTERS} characters`,
        },
        413
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
        ? "tts-1-hd"
        : DEFAULT_SPEECH_MODEL;

    if (prefersHd && chosenModel !== "tts-1-hd") {
      chosenModel = "tts-1-hd";
    }
    const normalizedFormat = format?.toLowerCase() as SpeechFormat | undefined;
    const chosenFormat: SpeechFormat =
      normalizedFormat && ALLOWED_SPEECH_FORMATS.includes(normalizedFormat)
        ? normalizedFormat
        : DEFAULT_SPEECH_FORMAT;

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
      });
    } catch (synthesisError: any) {
      clearTimeout(timeoutId);

      if (abortController.signal.aborted) {
        const wasCancelled = c.req.raw.signal?.aborted;
        return c.json(
          {
            error: wasCancelled ? "Request cancelled" : "Request timeout",
            message: wasCancelled
              ? "Request was cancelled by client"
              : "Request exceeded timeout limit",
          },
          408
        );
      }

      throw synthesisError;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!relayResult || (!relayResult.audioBase64 && !relayResult.segments?.length)) {
      throw new Error("Dub synthesis returned no audio segments");
    }

    const cleanedScript = script.replace(/\s+/g, " ").trim();
    const estimatedTokens = Math.max(1, Math.ceil(cleanedScript.length / 4));
    const approxSeconds = segments.reduce((sum, seg) => {
      const start = typeof seg.start === "number" ? seg.start : 0;
      const end = typeof seg.end === "number" ? seg.end : start;
      const delta = end - start;
      return sum + (Number.isFinite(delta) && delta > 0 ? delta : 0);
    }, 0);

    const usedRelay = relayResult.usedRelay;

    const ok = await deductSpeechCredits({
      deviceId: user.deviceId,
      promptTokens: estimatedTokens,
      meta: {
        approxSeconds,
        usedRelay,
        model: chosenModel,
        quality: quality ?? "standard",
      },
    });

    if (!ok) {
      return c.json({ error: API_ERRORS.INSUFFICIENT_CREDITS }, 402);
    }

    const segmentCount =
      relayResult.segmentCount ?? relayResult.segments?.length ?? 0;
    const chunkCount = relayResult.chunkCount ?? (segmentCount || undefined);

    console.log(
      `[dub] relay success for ${user.deviceId} tokens=${estimatedTokens} segments=${segmentCount}`
    );

    return c.json({
      audioBase64: relayResult.audioBase64,
      segments: relayResult.segments,
      voice: relayResult.voice ?? chosenVoice,
      model: relayResult.model ?? chosenModel,
      format: relayResult.format ?? chosenFormat,
      estimatedTokens,
      approxSeconds,
      usedRelay,
      chunkCount,
      segmentCount,
    });
  } catch (error: any) {
    console.error("Error generating dub:", error);

    if (c.req.raw.signal?.aborted) {
      return c.json(
        { error: "Request cancelled", message: "Request was cancelled" },
        408
      );
    }

    return c.json(
      {
        error: "Failed to generate dub",
        message: error?.message || "Unknown error",
      },
      500
    );
  }
});

export default router;

const RETRYABLE_RELAY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);
const RETRYABLE_MESSAGE_PATTERN = /(timeout|timed out|temporarily unavailable|connection reset|gateway|rate limit|fetch failed)/i;

function extractRelayStatus(error: unknown): number | null {
  const message = typeof error === "string" ? error : String((error as any)?.message ?? "");
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
  const message = typeof error === "string" ? error : String((error as any)?.message ?? "");
  if (RETRYABLE_MESSAGE_PATTERN.test(message)) {
    return true;
  }
  const code = (error as any)?.code;
  if (typeof code === "string") {
    const normalized = code.toUpperCase();
    if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"].includes(normalized)) {
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
}

async function synthesizeDubWithFallback({
  c,
  sanitizedSegments,
  lines,
  voice,
  model,
  format,
  signal,
}: SynthRequest): Promise<SynthResult> {
  try {
    const relayResponse = await callDubRelay({
      c,
      lines,
      segments: sanitizedSegments,
      voice,
      model,
      format,
      signal,
    });
    return { ...relayResponse, usedRelay: true };
  } catch (error: any) {
    if (signal.aborted) {
      throw error;
    }

    if (!isRetryableRelayError(error)) {
      throw error;
    }

    console.warn(
      `[dub] Relay synthesis failed (${error?.message || error}); falling back to direct OpenAI speech. segments=${sanitizedSegments.length}`
    );

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

  const results: Array<{ index: number; audioBase64: string; targetDuration?: number }> = [];
  const errors: unknown[] = [];
  let cursor = 0;

  const maxConcurrency = Math.max(
    1,
    Math.min(FALLBACK_SEGMENT_CONCURRENCY, segments.length)
  );

  const workers = Array.from({ length: maxConcurrency }, async () => {
    while (true) {
      if (signal.aborted) {
        return;
      }

      const currentIndex = cursor++;
      if (currentIndex >= segments.length) {
        return;
      }

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

import OpenAI from "openai";
import { Context } from "hono";
import { OPENAI_RELAY_URL, SpeechFormat } from "./constants";

export class RelayHttpError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(body || `Relay HTTP error (${status})`);
    this.name = "RelayHttpError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Creates an OpenAI client for direct API calls (primary path)
 */
export function makeOpenAI(c: Context<any>) {
  return new OpenAI({
    apiKey: c.env.OPENAI_API_KEY,
    timeout: 600_000,
    maxRetries: 3,
  });
}

/**
 * Send transcription to relay (provider/model authority is server-side).
 */
export async function callRelayServer({
  c,
  file,
  model,
  qualityMode,
  idempotencyKey,
  language,
  prompt,
  signal,
}: {
  c: Context<any>;
  file: File;
  model: string;
  qualityMode?: boolean;
  idempotencyKey?: string;
  language?: string;
  prompt?: string;
  signal: AbortSignal;
}) {
  // Prepare form data for relay
  const relayFormData = new FormData();
  relayFormData.append("file", file);
  relayFormData.append("model", model);
  relayFormData.append("response_format", "verbose_json");
  relayFormData.append("timestamp_granularities[]", "word");
  relayFormData.append("timestamp_granularities[]", "segment");
  if (typeof qualityMode === "boolean") {
    relayFormData.append("qualityMode", String(qualityMode));
  }

  if (language) {
    relayFormData.append("language", language);
  }
  if (prompt) {
    relayFormData.append("prompt", prompt);
  }

  const relayResponse = await fetch(`${OPENAI_RELAY_URL}/transcribe`, {
    method: "POST",
    headers: {
      "X-Relay-Secret": c.env.RELAY_SECRET,
      "X-OpenAI-Key": c.env.OPENAI_API_KEY,
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...(c.env.ELEVENLABS_API_KEY
        ? { "X-ElevenLabs-Key": c.env.ELEVENLABS_API_KEY }
        : {}),
    },
    body: relayFormData,
    signal,
  });

  if (!relayResponse.ok) {
    const errorText = await relayResponse.text();
    console.error(
      `❌ Relay server error: ${relayResponse.status} ${errorText}`
    );
    throw new Error(`Relay server error: ${relayResponse.status} ${errorText}`);
  }

  const result = (await relayResponse.json()) as any;

  return result;
}

export async function submitTranslationRelayJob({
  c,
  payload,
  signal,
  requestId,
}: {
  c: Context<any>;
  payload: Record<string, unknown>;
  signal?: AbortSignal;
  requestId?: string;
}): Promise<
  | { type: "accepted"; relayJobId: string; status?: string }
  | { type: "completed"; result: any }
> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Relay-Secret": c.env.RELAY_SECRET,
    "X-OpenAI-Key": c.env.OPENAI_API_KEY,
  };

  // Include Anthropic key for Claude models
  if (c.env.ANTHROPIC_API_KEY) {
    headers["X-Anthropic-Key"] = c.env.ANTHROPIC_API_KEY;
  }
  if (requestId) {
    headers["X-Request-Id"] = requestId;
  }

  const resp = await fetch(`${OPENAI_RELAY_URL}/translate`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  });

  if (resp.status === 202) {
    const data = (await resp.json().catch((err) => {
      console.warn("[submitTranslationRelayJob] Failed to parse 202 response JSON:", err);
      return {};
    })) as { jobId?: string; status?: string } | undefined;
    const relayJobId = data?.jobId;
    if (!relayJobId) {
      throw new Error(
        `Translation relay server error: missing jobId (body=${JSON.stringify(
          data
        )})`
      );
    }
    return { type: "accepted", relayJobId, status: data?.status };
  }

  if (resp.status === 200) {
    const result = await resp.json();
    return { type: "completed", result };
  }

  const text = await resp.text();
  throw new RelayHttpError(resp.status, text || resp.statusText);
}

export async function fetchRelayTranslationStatus({
  c,
  relayJobId,
  signal,
  requestId,
}: {
  c: Context<any>;
  relayJobId: string;
  signal?: AbortSignal;
  requestId?: string;
}): Promise<
  | { type: "processing" }
  | { type: "completed"; result: any }
  | { type: "not_found" }
  | { type: "retryable_error"; statusCode: number; message: string }
  | { type: "error"; message: string }
> {
  const headers: Record<string, string> = {
    "X-Relay-Secret": c.env.RELAY_SECRET,
    "X-OpenAI-Key": c.env.OPENAI_API_KEY,
  };

  if (c.env.ANTHROPIC_API_KEY) {
    headers["X-Anthropic-Key"] = c.env.ANTHROPIC_API_KEY;
  }
  if (requestId) {
    headers["X-Request-Id"] = requestId;
  }

  const resp = await fetch(
    `${OPENAI_RELAY_URL}/translate/result/${encodeURIComponent(relayJobId)}`,
    {
      method: "GET",
      headers,
      signal,
    }
  );

  if (resp.status === 202) {
    return { type: "processing" };
  }

  if (resp.status === 200) {
    const result = await resp.json();
    return { type: "completed", result };
  }

  if (resp.status === 404) {
    return { type: "not_found" };
  }

  if (
    resp.status === 408 ||
    resp.status === 429 ||
    resp.status === 502 ||
    resp.status === 503 ||
    resp.status === 504
  ) {
    const text = await resp.text();
    return {
      type: "retryable_error",
      statusCode: resp.status,
      message: `${resp.status} ${text || resp.statusText}`,
    };
  }

  const text = await resp.text();
  return {
    type: "error",
    message: `${resp.status} ${text || resp.statusText}`,
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function callSpeechDirect({
  c,
  text,
  voice,
  model,
  format,
  signal,
}: {
  c: Context<any>;
  text: string;
  voice: string;
  model: string;
  format: SpeechFormat;
  signal?: AbortSignal;
}) {
  const openai = makeOpenAI(c);
  const speech = await openai.audio.speech.create(
    {
      model,
      voice,
      input: text,
      response_format: format,
    },
    { signal }
  );
  const arrayBuffer = await speech.arrayBuffer();
  return {
    audioBase64: arrayBufferToBase64(arrayBuffer),
    voice,
    model,
    format,
  };
}

export async function callDubRelay({
  c,
  lines,
  segments,
  voice,
  model,
  format,
  signal,
}: {
  c: Context<any>;
  lines?: string[];
  segments?: Array<{
    index: number;
    text: string;
    start?: number;
    end?: number;
    targetDuration?: number;
  }>;
  voice: string;
  model: string;
  format: SpeechFormat;
  signal?: AbortSignal;
}) {
  const payload: Record<string, unknown> = {
    voice,
    model,
    format,
  };

  if (segments?.length) {
    payload.segments = segments.map((seg, idx) => ({
      index: Number.isFinite(seg.index) ? seg.index : idx + 1,
      text: seg.text,
      start: seg.start,
      end: seg.end,
      targetDuration: seg.targetDuration,
    }));
  }

  if (lines?.length) {
    payload.lines = lines;
  }

  const resp = await fetch(`${OPENAI_RELAY_URL}/dub`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Relay-Secret": c.env.RELAY_SECRET,
      "X-OpenAI-Key": c.env.OPENAI_API_KEY,
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Dub relay server error: ${resp.status} ${text || resp.statusText}`
    );
  }

  return (await resp.json()) as {
    audioBase64?: string;
    voice?: string;
    model?: string;
    format?: SpeechFormat;
    chunkCount?: number;
    segmentCount?: number;
    totalCharacters?: number;
    segments?: Array<{
      index: number;
      audioBase64: string;
      targetDuration?: number;
    }>;
  };
}

/**
 * TODO(stage5-cleanup): Remove when legacy R2 transcription endpoints are retired.
 * Call relay server for ElevenLabs Scribe transcription from R2 URL
 * Used for large files that were uploaded directly to R2
 *
 * When webhookUrl is provided, the relay returns immediately and calls back
 * when done. This prevents Worker timeout issues.
 */
export async function callElevenLabsTranscribeFromR2({
  c,
  r2Url,
  language,
  webhookUrl,
}: {
  c: Context<any>;
  r2Url: string;
  language?: string;
  webhookUrl?: string;
}): Promise<{ status: "processing" } | any> {
  const payload: any = { r2Url };
  if (language) {
    payload.language = language;
  }
  if (webhookUrl) {
    payload.webhookUrl = webhookUrl;
  }

  const relayResponse = await fetch(`${OPENAI_RELAY_URL}/transcribe-from-r2`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Relay-Secret": c.env.RELAY_SECRET,
      "X-ElevenLabs-Key": c.env.ELEVENLABS_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  if (!relayResponse.ok) {
    const errorText = await relayResponse.text();
    console.error(
      `❌ ElevenLabs R2 relay error: ${relayResponse.status} ${errorText}`
    );
    throw new Error(`ElevenLabs R2 relay error: ${relayResponse.status} ${errorText}`);
  }

  return (await relayResponse.json()) as any;
}

/**
 * Call relay server for ElevenLabs TTS dubbing
 */
export async function callElevenLabsDubRelay({
  c,
  segments,
  voice,
  signal,
}: {
  c: Context<any>;
  segments: Array<{
    index: number;
    text: string;
    start?: number;
    end?: number;
    targetDuration?: number;
  }>;
  voice: string;
  signal?: AbortSignal;
}) {
  const payload = {
    segments: segments.map((seg, idx) => ({
      index: Number.isFinite(seg.index) ? seg.index : idx + 1,
      text: seg.text,
      targetDuration: seg.targetDuration,
    })),
    voice,
  };

  const resp = await fetch(`${OPENAI_RELAY_URL}/dub-elevenlabs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Relay-Secret": c.env.RELAY_SECRET,
      "X-ElevenLabs-Key": c.env.ELEVENLABS_API_KEY,
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `ElevenLabs dub relay error: ${resp.status} ${text || resp.statusText}`
    );
  }

  return (await resp.json()) as {
    voice?: string;
    model?: string;
    format?: string;
    segmentCount?: number;
    totalCharacters?: number;
    segments?: Array<{
      index: number;
      audioBase64: string;
      targetDuration?: number;
    }>;
  };
}

/**
 * Call relay server for ElevenLabs voice cloning dubbing (full Dubbing API)
 */
export async function callVoiceCloningRelay({
  c,
  fileBuffer,
  fileName,
  mimeType,
  targetLanguage,
  sourceLanguage,
  numSpeakers,
  dropBackgroundAudio = true,
}: {
  c: Context<any>;
  fileBuffer: ArrayBuffer;
  fileName: string;
  mimeType: string;
  targetLanguage: string;
  sourceLanguage?: string;
  numSpeakers?: number;
  dropBackgroundAudio?: boolean;
}): Promise<{
  audioBase64: string;
  transcript: string;
  format: string;
}> {
  const formData = new FormData();
  formData.append("file", new Blob([fileBuffer], { type: mimeType }), fileName);
  formData.append("target_language", targetLanguage);
  if (sourceLanguage) {
    formData.append("source_language", sourceLanguage);
  }
  if (numSpeakers !== undefined) {
    formData.append("num_speakers", String(numSpeakers));
  }
  formData.append("drop_background_audio", String(dropBackgroundAudio));

  const resp = await fetch(`${OPENAI_RELAY_URL}/dub-video-elevenlabs`, {
    method: "POST",
    headers: {
      "X-Relay-Secret": c.env.RELAY_SECRET,
      "X-ElevenLabs-Key": c.env.ELEVENLABS_API_KEY,
    },
    body: formData,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Voice cloning relay error: ${resp.status} ${text || resp.statusText}`
    );
  }

  return (await resp.json()) as {
    audioBase64: string;
    transcript: string;
    format: string;
  };
}

import OpenAI from "openai";
import { Context } from "hono";
import { OPENAI_RELAY_URL, SpeechFormat } from "./constants";

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
 * Check if error indicates geographical blocking
 */
export function isGeoBlockError(error: any): boolean {
  const errorMessage = error?.message?.toLowerCase() || "";
  const errorCode = error?.code || "";
  const statusCode = error?.status || error?.response?.status;

  // Common patterns for geo-blocking errors
  return (
    statusCode === 451 || // Unavailable For Legal Reasons
    errorMessage.includes("country") ||
    errorMessage.includes("region") ||
    errorMessage.includes("geographic") ||
    errorMessage.includes("location") ||
    errorMessage.includes("not available in your country") ||
    errorMessage.includes("restricted") ||
    errorMessage.includes("blocked") ||
    errorCode === "country_not_supported" ||
    errorCode === "region_not_supported" ||
    errorCode === "unsupported_country"
  );
}

/**
 * Fallback to relay server for geo-blocked requests
 */
export async function callRelayServer({
  c,
  file,
  model,
  language,
  prompt,
  signal,
}: {
  c: Context<any>;
  file: File;
  model: string;
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

/**
 * Fallback to relay server for translation requests
 */
export async function callTranslationRelay({
  c,
  text,
  target_language,
  model,
  signal,
}: {
  c: Context<any>;
  text: string;
  target_language: string;
  model: string;
  signal?: AbortSignal;
}) {
  const payload: Record<string, unknown> = {
    text,
    target_language,
    model,
  };

  const relayResponse = await fetch(`${OPENAI_RELAY_URL}/translate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Relay-Secret": c.env.RELAY_SECRET,
      "X-OpenAI-Key": c.env.OPENAI_API_KEY,
    },
    body: JSON.stringify(payload),
    signal,
  });

  return resolveRelayTranslationResponse({
    c,
    resp: relayResponse,
    signal,
    errorPrefix: "Translation relay server error",
  });
}

/**
 * Relay-first translation via chat-style payload (messages array)
 * Returns OpenAI-compatible chat.completions response (with usage) directly from relay
 */
export async function callChatRelay({
  c,
  messages,
  model,
  reasoning,
  signal,
}: {
  c: Context<any>;
  messages: Array<{ role: string; content: string }>;
  model: string;
  reasoning?: any;
  signal?: AbortSignal;
}) {
  const payload: Record<string, unknown> = { messages, model };
  if (reasoning !== undefined) {
    payload.reasoning = reasoning;
  }

  const resp = await fetch(`${OPENAI_RELAY_URL}/translate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Relay-Secret": c.env.RELAY_SECRET,
      "X-OpenAI-Key": c.env.OPENAI_API_KEY,
    },
    body: JSON.stringify(payload),
    signal,
  });

  return resolveRelayTranslationResponse({
    c,
    resp,
    signal,
    errorPrefix: "Relay chat translate error",
  });
}

export async function submitTranslationRelayJob({
  c,
  payload,
  signal,
}: {
  c: Context<any>;
  payload: Record<string, unknown>;
  signal?: AbortSignal;
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

  const resp = await fetch(`${OPENAI_RELAY_URL}/translate`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  });

  if (resp.status === 202) {
    const data = (await resp.json().catch(() => ({}))) as
      | { jobId?: string; status?: string }
      | undefined;
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
  throw new Error(
    `Translation relay server error: ${resp.status} ${text || resp.statusText}`
  );
}

export async function fetchRelayTranslationStatus({
  c,
  relayJobId,
  signal,
}: {
  c: Context<any>;
  relayJobId: string;
  signal?: AbortSignal;
}): Promise<
  | { type: "processing" }
  | { type: "completed"; result: any }
  | { type: "not_found" }
  | { type: "error"; message: string }
> {
  const headers: Record<string, string> = {
    "X-Relay-Secret": c.env.RELAY_SECRET,
    "X-OpenAI-Key": c.env.OPENAI_API_KEY,
  };

  if (c.env.ANTHROPIC_API_KEY) {
    headers["X-Anthropic-Key"] = c.env.ANTHROPIC_API_KEY;
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

async function resolveRelayTranslationResponse({
  c,
  resp,
  signal,
  errorPrefix,
}: {
  c: Context<any>;
  resp: Response;
  signal?: AbortSignal;
  errorPrefix: string;
}): Promise<any> {
  if (resp.status === 202) {
    let data: any = {};
    try {
      data = await resp.json();
    } catch {
      // ignore malformed body
    }

    const jobId = data?.jobId;
    if (!jobId) {
      throw new Error(`${errorPrefix}: missing jobId from relay response`);
    }

    const pollHeaders = {
      "X-Relay-Secret": c.env.RELAY_SECRET,
      "X-OpenAI-Key": c.env.OPENAI_API_KEY,
    };

    const pollIntervalMs = 2000;
    const maxWaitMs = 600_000; // 10 minutes
    const startTime = Date.now();

    while (true) {
      if (signal?.aborted) {
        throw new DOMException("Operation cancelled", "AbortError");
      }

      if (Date.now() - startTime > maxWaitMs) {
        throw new Error(`${errorPrefix}: job ${jobId} timed out`);
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

      const statusResp = await fetch(
        `${OPENAI_RELAY_URL}/translate/result/${jobId}`,
        {
          method: "GET",
          headers: pollHeaders,
          signal,
        }
      );

      if (statusResp.status === 202) {
        continue;
      }

      if (statusResp.status === 200) {
        return statusResp.json();
      }

      if (statusResp.status === 404) {
        const text = await statusResp.text();
        throw new Error(
          `${errorPrefix}: job ${jobId} not found (${text || "404"})`
        );
      }

      const text = await statusResp.text();
      throw new Error(`${errorPrefix}: ${statusResp.status} ${text}`);
    }
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${errorPrefix}: ${resp.status} ${text}`);
  }

  return resp.json();
}

export async function callSpeechRelay({
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
  const resp = await fetch(`${OPENAI_RELAY_URL}/speech`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Relay-Secret": c.env.RELAY_SECRET,
      "X-OpenAI-Key": c.env.OPENAI_API_KEY,
    },
    body: JSON.stringify({ text, voice, model, format }),
    signal,
  });

  if (!resp.ok) {
    const textBody = await resp.text();
    throw new Error(
      `Speech relay server error: ${resp.status} ${textBody || resp.statusText}`
    );
  }

  return (await resp.json()) as {
    audioBase64: string;
    voice: string;
    model: string;
    format: string;
  };
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
 * Maps OpenAI SDK endpoints to relay endpoints
 */
export const RELAY_ENDPOINT_MAPPING = {
  "audio.transcriptions.create": "/transcribe",
  "chat.completions.create": "/translate",
} as const;

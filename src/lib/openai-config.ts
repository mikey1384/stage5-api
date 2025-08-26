import OpenAI from "openai";
import Groq from "groq-sdk";
import { Context } from "hono";
import { OPENAI_RELAY_URL } from "./constants";

/**
 * Creates an OpenAI client for direct API calls (primary path)
 */
export function makeOpenAI(c: Context<any>) {
  return new OpenAI({
    apiKey: c.env.OPENAI_API_KEY,
    timeout: 60_000, // 1 minute for direct calls
    maxRetries: 3,
  });
}

/**
 * Creates a Groq client using OpenAI SDK compatibility
 */
export function makeGroq(c: Context<any>) {
  return new Groq({
    apiKey: c.env.GROQ_API_KEY,
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
}: {
  c: Context<any>;
  text: string;
  target_language: string;
  model: string;
}) {
  const relayResponse = await fetch(`${OPENAI_RELAY_URL}/translate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Relay-Secret": c.env.RELAY_SECRET,
      "X-OpenAI-Key": c.env.OPENAI_API_KEY,
    },
    body: JSON.stringify({
      text,
      target_language,
      model,
    }),
  });

  if (!relayResponse.ok) {
    const errorText = await relayResponse.text();
    console.error(
      `❌ Translation relay server error: ${relayResponse.status} ${errorText}`
    );
    throw new Error(
      `Translation relay server error: ${relayResponse.status} ${errorText}`
    );
  }

  const result = (await relayResponse.json()) as any;

  // Convert relay response format to OpenAI format
  return {
    choices: [
      {
        message: {
          content: result.translated_text,
          role: "assistant",
        },
      },
    ],
    usage: {
      prompt_tokens: Math.ceil(text.length / 4), // Rough estimate
      completion_tokens: Math.ceil(result.translated_text.length / 4), // Rough estimate
      total_tokens: Math.ceil(
        (text.length + result.translated_text.length) / 4
      ),
    },
  };
}

/**
 * Maps OpenAI SDK endpoints to relay endpoints
 */
export const RELAY_ENDPOINT_MAPPING = {
  "audio.transcriptions.create": "/transcribe",
  "chat.completions.create": "/translate",
} as const;

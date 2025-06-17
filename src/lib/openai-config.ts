import OpenAI from "openai";
import { Context } from "hono";
import { OPENAI_RELAY_URL, USE_RELAY } from "./constants";

type Bindings = {
  OPENAI_API_KEY: string;
  RELAY_SECRET: string;
  DB: D1Database;
};

/**
 * Creates an OpenAI client that uses the relay for global compatibility
 */
export function makeOpenAI(c: Context<any>) {
  const config: ConstructorParameters<typeof OpenAI>[0] = {
    apiKey: c.env.OPENAI_API_KEY,
    timeout: 300_000, // 5 minutes for transcription
    maxRetries: 3,
  };

  // Use relay for global compatibility - pass credentials via headers
  if (USE_RELAY) {
    config.baseURL = OPENAI_RELAY_URL;
    config.defaultHeaders = {
      'X-Relay-Secret': c.env.RELAY_SECRET,
      'X-OpenAI-Key': c.env.OPENAI_API_KEY,
    };
    console.log(`Using OpenAI relay: ${OPENAI_RELAY_URL}`);
  }

  return new OpenAI(config);
}

/**
 * Maps OpenAI SDK endpoints to relay endpoints
 */
export const RELAY_ENDPOINT_MAPPING = {
  'audio.transcriptions.create': '/transcribe',
  'chat.completions.create': '/translate',
} as const;

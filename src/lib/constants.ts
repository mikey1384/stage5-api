import { STAGE5_TTS_MODEL_ELEVEN_V4 } from "./model-catalog";

// Managed dubbing is ElevenLabs-only: OpenAI's TTS models (tts-1, tts-1-hd,
// gpt-4o-mini-tts) shut down on 2027-01-06.
export const DEFAULT_SPEECH_MODEL = STAGE5_TTS_MODEL_ELEVEN_V4;
// What the old OpenAI default voice ("alloy") maps to.
export const DEFAULT_SPEECH_VOICE = "adam";
/**
 * Legacy OpenAI voice names that older Translator versions still send, mapped
 * onto the ElevenLabs voices the Translator offers (rachel, adam, josh, sarah,
 * charlie, emily, matilda, brian). The relay keeps an identical copy in
 * openai-relay/elevenlabs-voices.ts; keep the two in sync.
 */
export const OPENAI_TO_ELEVENLABS_VOICE: Readonly<Record<string, string>> = {
  alloy: "adam",
  echo: "brian",
  fable: "emily",
  onyx: "josh",
  nova: "rachel",
  shimmer: "sarah",
};
export const ALLOWED_SPEECH_VOICES = [
  // Legacy OpenAI voice names (mapped via OPENAI_TO_ELEVENLABS_VOICE)
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
  // ElevenLabs voices
  "rachel",
  "adam",
  "josh",
  "sarah",
  "charlie",
  "emily",
  "matilda",
  "brian",
  "domi",
  "bella",
  "antoni",
  "elli",
  "arnold",
  "sam",
];
// ElevenLabs output formats the relay supports (OpenAI's aac/flac are gone;
// requests for them fall back to DEFAULT_SPEECH_FORMAT).
export const ALLOWED_SPEECH_FORMATS = ["mp3", "opus", "wav", "pcm"] as const;
export type SpeechFormat = (typeof ALLOWED_SPEECH_FORMATS)[number];
export const DEFAULT_SPEECH_FORMAT: SpeechFormat = "mp3";

/**
 * Resolve a requested dub voice to the ElevenLabs voice to synthesize with.
 * Unknown voices fall back to DEFAULT_SPEECH_VOICE; OpenAI names are mapped.
 */
export function resolveDubVoice(voice?: string | null): string {
  const key = typeof voice === "string" ? voice.trim().toLowerCase() : "";
  if (!key || !ALLOWED_SPEECH_VOICES.includes(key)) {
    return DEFAULT_SPEECH_VOICE;
  }
  return OPENAI_TO_ELEVENLABS_VOICE[key] ?? key;
}

// File upload limits
export const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB

// OpenAI Relay Configuration
export const OPENAI_RELAY_URL = "https://translator-relay.fly.dev";
export const STAGE5_API_BASE_URL = "https://api.stage5.tools";
export const USE_RELAY = false; // Use fallback strategy: try direct first, relay on geo-block

// API Error types
export const API_ERRORS = {
  INSUFFICIENT_CREDITS: "insufficient-credits",
  INVALID_MODEL: "invalid-model",
  INVALID_REQUEST: "invalid-request",
  FILE_TOO_LARGE: "file-too-large",
  UNAUTHORIZED: "unauthorized",
} as const;

export type ApiError = (typeof API_ERRORS)[keyof typeof API_ERRORS];

// Helper to determine provider from model
export function isClaudeModel(model: string | undefined): boolean {
  return Boolean(model && model.startsWith("claude-"));
}

export function getProviderFromModel(model: string): "Anthropic" | "OpenAI" {
  return isClaudeModel(model) ? "Anthropic" : "OpenAI";
}

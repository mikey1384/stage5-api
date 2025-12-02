export const ALLOWED_TRANSCRIPTION_MODELS = ["whisper-1"];

export const ALLOWED_SPEECH_MODELS = ["tts-1", "tts-1-hd"];

export const DEFAULT_SPEECH_MODEL = "tts-1";
export const DEFAULT_SPEECH_VOICE = "alloy";
export const ALLOWED_SPEECH_VOICES = [
  // OpenAI TTS voices
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
export const ALLOWED_SPEECH_FORMATS = [
  "mp3",
  "opus",
  "aac",
  "flac",
  "wav",
  "pcm",
] as const;
export type SpeechFormat = (typeof ALLOWED_SPEECH_FORMATS)[number];
export const DEFAULT_SPEECH_FORMAT: SpeechFormat = "mp3";

// File upload limits
export const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB

// OpenAI Relay Configuration
export const OPENAI_RELAY_URL = "https://translator-relay.fly.dev";
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

export const ALLOWED_TRANSLATION_MODELS = [
  "gpt-5",
  "gpt-5-mini",
  "gpt-4.1",
  "o3",
];
export const ALLOWED_TRANSCRIPTION_MODELS = [
  "whisper-1",
  "whisper-large-v3",
  "whisper-large-v3-turbo",
];

export const ALLOWED_SPEECH_MODELS = [
  "tts-1",
  "tts-1-hd",
];

export const DEFAULT_SPEECH_MODEL = "tts-1";
export const DEFAULT_SPEECH_VOICE = "alloy";
export const ALLOWED_SPEECH_VOICES = [
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
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

// Temperature constraints
export const MIN_TEMPERATURE = 0;
export const MAX_TEMPERATURE = 1;
export const DEFAULT_TEMPERATURE = 0.4;

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

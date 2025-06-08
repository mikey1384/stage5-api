export const ALLOWED_TRANSLATION_MODEL = "gpt-4.1";
export const ALLOWED_TRANSCRIPTION_MODEL = "whisper-1";

// Temperature constraints
export const MIN_TEMPERATURE = 0;
export const MAX_TEMPERATURE = 1;
export const DEFAULT_TEMPERATURE = 0.4;

// File upload limits
export const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB

// API Error types
export const API_ERRORS = {
  INSUFFICIENT_CREDITS: "insufficient-credits",
  INVALID_MODEL: "invalid-model",
  INVALID_REQUEST: "invalid-request",
  FILE_TOO_LARGE: "file-too-large",
  UNAUTHORIZED: "unauthorized",
} as const;

export type ApiError = (typeof API_ERRORS)[keyof typeof API_ERRORS];

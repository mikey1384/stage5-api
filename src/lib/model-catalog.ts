function canonicalizeModelId(model?: string): string {
  return String(model || "")
    .trim()
    .toLowerCase();
}

export const DEFAULT_STAGE5_TRANSLATION_MODEL = "gpt-5.1";
export const STAGE5_REVIEW_TRANSLATION_MODEL = "gpt-5.4";
export const STAGE5_WHISPER_MODEL = "whisper-1";
export const STAGE5_ELEVENLABS_SCRIBE_MODEL = "elevenlabs-scribe";
export const STAGE5_TTS_MODEL_STANDARD = "tts-1";
export const STAGE5_TTS_MODEL_HD = "tts-1-hd";
export const STAGE5_TTS_MODEL_ELEVEN_V3 = "eleven_v3";
const STAGE5_TTS_MODEL_ELEVEN_MULTILINGUAL_V2_LEGACY = "eleven_multilingual_v2";

export const STAGE5_TRANSLATION_MODEL_ALIASES = {
  "claude-opus-4.6": "claude-opus-4-6",
} as const;

export const STAGE5_TRANSLATION_MODEL_PRICES = {
  "gpt-5.1": {
    in: 1.25 / 1_000_000, // $1.25 per million tokens
    out: 10 / 1_000_000, // $10.00 per million tokens
  },
  "gpt-5.4": {
    in: 2.5 / 1_000_000, // $2.50 per million tokens
    out: 15 / 1_000_000, // $15.00 per million tokens
  },
  "claude-opus-4-6": {
    in: 5 / 1_000_000, // $5.00 per million tokens
    out: 25 / 1_000_000, // $25.00 per million tokens
  },
} as const;

export const STAGE5_TRANSCRIPTION_MODEL_PRICES = {
  [STAGE5_WHISPER_MODEL]: {
    perSecond: 0.006 / 60, // $0.006 per minute = $0.36/hr
  },
  [STAGE5_ELEVENLABS_SCRIBE_MODEL]: {
    // ElevenLabs Pro API overage rate: $0.40 per additional hour.
    perSecond: 0.4 / 3600,
  },
} as const;

export const STAGE5_TTS_MODEL_PRICES = {
  [STAGE5_TTS_MODEL_STANDARD]: {
    perChar: 15 / 1_000_000, // $15 per 1M characters
  },
  [STAGE5_TTS_MODEL_HD]: {
    perChar: 30 / 1_000_000, // $30 per 1M characters
  },
  [STAGE5_TTS_MODEL_ELEVEN_V3]: {
    // ElevenLabs Pro highest-quality TTS overage rate: $0.18 per 1K chars.
    perChar: 180 / 1_000_000,
  },
  [STAGE5_TTS_MODEL_ELEVEN_MULTILINGUAL_V2_LEGACY]: {
    // Legacy alias kept so older clients and in-flight reservations price correctly.
    perChar: 180 / 1_000_000,
  },
  eleven_turbo_v2_5: {
    // ElevenLabs Pro turbo/flash TTS overage rate: $0.09 per 1K chars.
    perChar: 90 / 1_000_000,
  },
} as const;

export type Stage5TranslationModelId =
  keyof typeof STAGE5_TRANSLATION_MODEL_PRICES;
export type Stage5TranscriptionModelId =
  keyof typeof STAGE5_TRANSCRIPTION_MODEL_PRICES;
export type Stage5TtsModelId = keyof typeof STAGE5_TTS_MODEL_PRICES;

export function normalizeStage5TranslationModel(model?: string): string {
  const canonical = canonicalizeModelId(model);
  if (!canonical) return DEFAULT_STAGE5_TRANSLATION_MODEL;
  return (
    STAGE5_TRANSLATION_MODEL_ALIASES[
      canonical as keyof typeof STAGE5_TRANSLATION_MODEL_ALIASES
    ] || canonical
  );
}

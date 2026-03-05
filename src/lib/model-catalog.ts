function canonicalizeModelId(model?: string): string {
  return String(model || "").trim().toLowerCase();
}

export const DEFAULT_STAGE5_TRANSLATION_MODEL = "gpt-5.1";
export const STAGE5_WHISPER_MODEL = "whisper-1";
export const STAGE5_ELEVENLABS_SCRIBE_MODEL = "elevenlabs-scribe";
export const STAGE5_TTS_MODEL_STANDARD = "tts-1";
export const STAGE5_TTS_MODEL_HD = "tts-1-hd";

export const STAGE5_TRANSLATION_MODEL_ALIASES = {
  "claude-opus-4.6": "claude-opus-4-6",
} as const;

export const STAGE5_TRANSLATION_MODEL_PRICES = {
  "gpt-5.1": {
    in: 1.25 / 1_000_000, // $1.25 per million tokens
    out: 10 / 1_000_000, // $10.00 per million tokens
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
    perSecond: 0.27 / 3600, // ~1.35x margin on $0.40/hr to match translation rate
  },
} as const;

export const STAGE5_TTS_MODEL_PRICES = {
  [STAGE5_TTS_MODEL_STANDARD]: {
    perChar: 15 / 1_000_000, // $15 per 1M characters
  },
  [STAGE5_TTS_MODEL_HD]: {
    perChar: 30 / 1_000_000, // $30 per 1M characters
  },
  "eleven_multilingual_v2": {
    perChar: 200 / 1_000_000, // ~$200 per 1M characters (Pro tier estimate)
  },
  "eleven_turbo_v2_5": {
    perChar: 100 / 1_000_000, // ~$100 per 1M characters (50% cheaper than v2)
  },
} as const;

export type Stage5TranslationModelId = keyof typeof STAGE5_TRANSLATION_MODEL_PRICES;
export type Stage5TranscriptionModelId = keyof typeof STAGE5_TRANSCRIPTION_MODEL_PRICES;
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

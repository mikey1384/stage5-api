export const USD_PER_CREDIT = 10 / 350_000;
export const MARGIN = 2;
export const CREDITS_PER_AUDIO_HOUR = 18_900; // ~12,600 base × 1.5x overhead

export const MODEL_PRICES = {
  "gpt-5.1": {
    in: 1.25 / 1_000_000, // $1.25 per million tokens
    out: 10 / 1_000_000, // $10.00 per million tokens
  },

  "claude-opus-4-5-20251101": {
    in: 5 / 1_000_000, // $5.00 per million tokens
    out: 25 / 1_000_000, // $25.00 per million tokens
  },

  "whisper-1": {
    perSecond: 0.006 / 60, // $0.006 per minute = $0.36/hr
  },

  "elevenlabs-scribe": {
    perSecond: 0.27 / 3600, // ~1.35x margin on $0.40/hr to match translation rate
  },
} as const;

// TTS pricing (per character)
export const TTS_PRICES = {
  "tts-1": {
    perChar: 15 / 1_000_000, // $15 per 1M characters
  },
  "tts-1-hd": {
    perChar: 30 / 1_000_000, // $30 per 1M characters
  },
  "eleven_multilingual_v2": {
    perChar: 200 / 1_000_000, // ~$200 per 1M characters (Pro tier estimate)
  },
  "eleven_turbo_v2_5": {
    perChar: 100 / 1_000_000, // ~$100 per 1M characters (50% cheaper than v2)
  },
} as const;

export type TTSModel = keyof typeof TTS_PRICES;

// Calibration factors (1.0 = no adjustment)
export const AUDIO_CREDIT_CALIBRATION = 1.0;
export const TOKEN_CREDIT_CALIBRATION = 1.0;
export const TTS_CREDIT_CALIBRATION = 1.0;

export function secondsToCredits({
  seconds,
  model,
}: {
  seconds: number;
  model: string;
}): number {
  const price = MODEL_PRICES[model as keyof typeof MODEL_PRICES];
  if (!price || !("perSecond" in price)) {
    throw new Error(`No pricing defined for model: ${model}`);
  }
  const usd = seconds * price.perSecond;
  const credits = (usd * MARGIN) / USD_PER_CREDIT;
  return Math.ceil(credits * AUDIO_CREDIT_CALIBRATION);
}

// Get allowed translation models (token-based models only)
export function getAllowedTranslationModels(): string[] {
  return Object.keys(MODEL_PRICES).filter(
    (model) => "in" in MODEL_PRICES[model as keyof typeof MODEL_PRICES]
  );
}

export function tokensToCredits({
  prompt,
  completion,
  model = "gpt-5.1",
}: {
  prompt: number;
  completion: number;
  model?: string;
}): number {
  const pricing = MODEL_PRICES[model as keyof typeof MODEL_PRICES];
  if (!pricing || !("in" in pricing)) {
    // Fallback to GPT-5.1 pricing for unknown models
    const usd =
      prompt * MODEL_PRICES["gpt-5.1"].in +
      completion * MODEL_PRICES["gpt-5.1"].out;
    const credits = (usd * MARGIN) / USD_PER_CREDIT;
    return Math.ceil(credits * TOKEN_CREDIT_CALIBRATION);
  }

  const usd = prompt * pricing.in + completion * pricing.out;
  const credits = (usd * MARGIN) / USD_PER_CREDIT;
  return Math.ceil(credits * TOKEN_CREDIT_CALIBRATION);
}

/**
 * Convert character count to credits for TTS models
 */
export function charactersToCredits({
  characters,
  model,
}: {
  characters: number;
  model: TTSModel;
}): number {
  const pricing = TTS_PRICES[model];
  if (!pricing) {
    // Fallback to tts-1 pricing for unknown models
    const usd = characters * TTS_PRICES["tts-1"].perChar;
    const credits = (usd * MARGIN) / USD_PER_CREDIT;
    return Math.ceil(credits * TTS_CREDIT_CALIBRATION);
  }

  const usd = characters * pricing.perChar;
  const credits = (usd * MARGIN) / USD_PER_CREDIT;
  return Math.ceil(credits * TTS_CREDIT_CALIBRATION);
}

/**
 * Estimate credits for a dubbing job (for UI cost preview)
 */
export function estimateDubbingCredits({
  characters,
  model,
}: {
  characters: number;
  model: TTSModel;
}): { credits: number; usdEstimate: number } {
  const pricing = TTS_PRICES[model] ?? TTS_PRICES["tts-1"];
  const usd = characters * pricing.perChar;
  const credits = Math.ceil((usd * MARGIN) / USD_PER_CREDIT * TTS_CREDIT_CALIBRATION);
  return { credits, usdEstimate: usd };
}

/**
 * Get all available TTS models
 */
export function getAllowedTTSModels(): TTSModel[] {
  return Object.keys(TTS_PRICES) as TTSModel[];
}

// Voice cloning pricing (ElevenLabs Dubbing API)
// ElevenLabs charges ~$0.50/min, we add MARGIN for Stage5 credits
const VOICE_CLONING_USD_PER_MINUTE = 0.50;

/**
 * Estimate credits for voice cloning dubbing (duration-based, not character-based)
 */
export function estimateVoiceCloningCredits({
  durationSeconds,
}: {
  durationSeconds: number;
}): { credits: number; usdEstimate: number } {
  const minutes = durationSeconds / 60;
  const usd = minutes * VOICE_CLONING_USD_PER_MINUTE;
  const credits = Math.ceil((usd * MARGIN) / USD_PER_CREDIT);
  return { credits, usdEstimate: usd };
}

/**
 * Get credits per minute for voice cloning (for UI display)
 */
export function getVoiceCloningCreditsPerMinute(): number {
  const usdPerMinute = VOICE_CLONING_USD_PER_MINUTE;
  return Math.ceil((usdPerMinute * MARGIN) / USD_PER_CREDIT);
}

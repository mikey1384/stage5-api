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
} as const;

// Calibration factors (1.0 = no adjustment)
export const AUDIO_CREDIT_CALIBRATION = 1.0;
export const TOKEN_CREDIT_CALIBRATION = 1.0;

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

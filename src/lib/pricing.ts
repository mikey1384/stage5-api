export const USD_PER_CREDIT = 10 / 350_000;
export const MARGIN = 2;

export const MODEL_PRICES = {
  "gpt-4.1": {
    in: 2 / 1_000_000, // 0.000002
    out: 8 / 1_000_000, // 0.000008
  },

  "whisper-1": {
    perSecond: 0.006 / 60, // 0.0001
  },

  "whisper-large-v3": {
    perSecond: 0.111 / 3600, // ~0.00003083
  },

  "whisper-large-v3-turbo": {
    perSecond: 0.04 / 3600, // ~0.00001111
  },
} as const;

export const CREDITS_PER_AUDIO_HOUR = 50_000;

export const AUDIO_CREDIT_CALIBRATION =
  Number(process.env.AUDIO_CREDIT_CALIBRATION ?? 1) || 1;

export const TOKEN_CREDIT_CALIBRATION =
  Number(process.env.TOKEN_CREDIT_CALIBRATION ?? 1) || 1;

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

export function tokensToCredits({
  prompt,
  completion,
}: {
  prompt: number;
  completion: number;
}): number {
  const usd =
    prompt * MODEL_PRICES["gpt-4.1"].in +
    completion * MODEL_PRICES["gpt-4.1"].out;

  const credits = (usd * MARGIN) / USD_PER_CREDIT;
  return Math.ceil(credits * TOKEN_CREDIT_CALIBRATION);
}

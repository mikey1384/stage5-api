export const CREDIT_USD = 0.00004; // $10 pack → 250 000 credits
export const MARGIN = 2; // 2× markup  (= 50 000 credits ≈ $2)

export const MODEL_PRICES = {
  "gpt-4.1": {
    in: 2 / 1_000_000, // 0.000002
    out: 8 / 1_000_000, // 0.000008
  },

  "whisper-1": {
    perSecond: 0.006 / 60, // 0.0001
  },
} as const;

/** Users should get ≈10 h for a $10 pack → 25 000 credits per h */
export const CREDITS_PER_AUDIO_HOUR = 25_000;

/* Helpers ------------------------------------------------------*/

export function secondsToCredits({ seconds }: { seconds: number }): number {
  // Direct conversion: 25,000 credits per hour
  return Math.ceil(seconds * (CREDITS_PER_AUDIO_HOUR / 3600));
}

/* Translation stays cost-based, no change needed */
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
  return Math.ceil((usd * MARGIN) / CREDIT_USD);
}

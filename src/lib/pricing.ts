export const USD_PER_CREDIT = 10 / 300_000; // $10 pack → 300,000 credits. Starter ($5) = 150k, Pro ($50) = 2.4M
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

export const CREDITS_PER_AUDIO_HOUR = 100_000;

/* Helpers ------------------------------------------------------*/

export function secondsToCredits({ seconds }: { seconds: number }): number {
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
  return Math.ceil((usd * MARGIN) / USD_PER_CREDIT);
}

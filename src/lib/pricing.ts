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

export const CREDITS_PER_AUDIO_HOUR = Math.round(
  (60 * 60 * MODEL_PRICES["whisper-1"].perSecond * MARGIN) / CREDIT_USD
); // 17 999.999… → 18 000

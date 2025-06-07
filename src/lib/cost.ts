import { CREDIT_USD, MARGIN, MODEL_PRICES } from "./pricing";

/* ───── Translation (GPT-4.1) ───── */
export function tokensToCredits({
  prompt,
  completion,
}: {
  prompt: number;
  completion: number;
}) {
  const usd =
    prompt * MODEL_PRICES["gpt-4.1"].in +
    completion * MODEL_PRICES["gpt-4.1"].out;

  return Math.ceil((usd * MARGIN) / CREDIT_USD);
}

/* ───── Transcription (Whisper) ───── */
export function secondsToCredits({ seconds }: { seconds: number }) {
  const usd = seconds * MODEL_PRICES["whisper-1"].perSecond;
  return Math.ceil((usd * MARGIN) / CREDIT_USD);
}

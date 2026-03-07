import {
  DEFAULT_STAGE5_TRANSLATION_MODEL,
  normalizeStage5TranslationModel,
  STAGE5_TRANSCRIPTION_MODEL_PRICES,
  STAGE5_TTS_MODEL_STANDARD,
  STAGE5_TRANSLATION_MODEL_PRICES,
  STAGE5_TTS_MODEL_PRICES,
} from "./model-catalog";

export const USD_PER_CREDIT = 10 / 350_000;
export const MARGIN = 2;
export const CREDITS_PER_AUDIO_HOUR = 18_900; // ~12,600 base × 1.5x overhead
export const WEB_SEARCH_USD_PER_CALL = 10 / 1_000; // $10 / 1K calls

export const MODEL_PRICES = {
  ...STAGE5_TRANSLATION_MODEL_PRICES,
  ...STAGE5_TRANSCRIPTION_MODEL_PRICES,
} as const;

// TTS pricing (per character)
export const TTS_PRICES = STAGE5_TTS_MODEL_PRICES;

export type TTSModel = keyof typeof TTS_PRICES;

// Calibration factors (1.0 = no adjustment)
export const AUDIO_CREDIT_CALIBRATION = 1.0;
export const TOKEN_CREDIT_CALIBRATION = 1.0;
export const TTS_CREDIT_CALIBRATION = 1.0;

export function normalizeTranslationModel(model?: string): string {
  return normalizeStage5TranslationModel(model);
}

function getTokenModelPricing(
  model: string
): { in: number; out: number } | null {
  const normalizedModel = normalizeTranslationModel(model);
  const pricing = MODEL_PRICES[normalizedModel as keyof typeof MODEL_PRICES];
  if (!pricing || !("in" in pricing) || !("out" in pricing)) {
    return null;
  }
  return { in: pricing.in, out: pricing.out };
}

export function secondsToCredits({
  seconds,
  model,
}: {
  seconds: number;
  model: string;
}): number {
  const normalizedModel = String(model || "").trim().toLowerCase();
  const price = MODEL_PRICES[normalizedModel as keyof typeof MODEL_PRICES];
  if (!price || !("perSecond" in price)) {
    throw new Error(`No pricing defined for model: ${normalizedModel || model}`);
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

export function isAllowedTranslationModel(model?: string): boolean {
  const normalizedModel = normalizeTranslationModel(model);
  return getTokenModelPricing(normalizedModel) !== null;
}

export function tokensToCredits({
  prompt,
  completion,
  model = DEFAULT_STAGE5_TRANSLATION_MODEL,
}: {
  prompt: number;
  completion: number;
  model?: string;
}): number {
  const normalizedModel = normalizeTranslationModel(model);
  const pricing = getTokenModelPricing(normalizedModel);
  if (!pricing) {
    throw new Error(`No translation pricing defined for model: ${normalizedModel}`);
  }

  const usd = prompt * pricing.in + completion * pricing.out;
  const credits = (usd * MARGIN) / USD_PER_CREDIT;
  return Math.ceil(credits * TOKEN_CREDIT_CALIBRATION);
}

export function webSearchCallsToCredits({
  calls,
}: {
  calls: number;
}): number {
  const normalizedCalls = Math.max(0, Math.ceil(calls));
  if (normalizedCalls === 0) return 0;
  const usd = normalizedCalls * WEB_SEARCH_USD_PER_CALL;
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
    const usd = characters * TTS_PRICES[STAGE5_TTS_MODEL_STANDARD].perChar;
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
  const pricing = TTS_PRICES[model] ?? TTS_PRICES[STAGE5_TTS_MODEL_STANDARD];
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

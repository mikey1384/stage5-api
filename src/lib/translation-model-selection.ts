import { isClaudeModel } from "./constants";
import { isAllowedTranslationModel, normalizeTranslationModel } from "./pricing";
import {
  STAGE5_REVIEW_TRANSLATION_MODEL,
  normalizeStage5TranslationModel,
} from "./model-catalog";

export type TranslationModelFamily = "gpt" | "claude" | "auto";
export type TranslationPhase = "draft" | "review";

export type TranslationChatMessage = {
  role: string;
  content: string;
};

export const DEFAULT_TRANSLATION_MAX_COMPLETION_TOKENS = 16_000;
export const EXTENDED_TRANSLATION_MAX_COMPLETION_TOKENS = 32_000;
const STAGE5_ANTHROPIC_REVIEW_TRANSLATION_MODEL = normalizeStage5TranslationModel(
  "claude-opus-4.6"
);

export function isLikelySubtitleReviewMessages(
  messages: TranslationChatMessage[] | undefined
): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const systemText = messages
    .filter((message) => String(message?.role ?? "").toLowerCase() === "system")
    .map((message) => String(message?.content ?? ""))
    .join("\n")
    .toLowerCase();

  if (!systemText) return false;

  return (
    systemText.includes("subtitle reviewer.") &&
    systemText.includes("output exactly") &&
    systemText.includes("@@sub_line@@") &&
    systemText.includes("no commentary.")
  );
}

export function isLikelySubtitleDraftMessages(
  messages: TranslationChatMessage[] | undefined
): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const systemText = messages
    .filter((message) => String(message?.role ?? "").toLowerCase() === "system")
    .map((message) => String(message?.content ?? ""))
    .join("\n")
    .toLowerCase();

  if (!systemText) return false;

  return (
    systemText.includes("subtitle translator.") &&
    systemText.includes("output exactly") &&
    systemText.includes("@@sub_line@@")
  );
}

export function resolveAuthoritativeTranslationModel({
  requestedModel,
  modelFamily,
  messages,
  canUseAnthropic,
  translationPhase,
  qualityMode,
}: {
  requestedModel?: string;
  modelFamily?: TranslationModelFamily;
  messages?: TranslationChatMessage[];
  canUseAnthropic: boolean;
  translationPhase?: TranslationPhase;
  qualityMode?: boolean;
}): string {
  const normalizedRequestedModel = normalizeTranslationModel(requestedModel);
  const reviewByHeuristic = isLikelySubtitleReviewMessages(messages);
  const draftByHeuristic = isLikelySubtitleDraftMessages(messages);
  const isSubtitleWorkflow =
    translationPhase === "review" ||
    translationPhase === "draft" ||
    reviewByHeuristic ||
    draftByHeuristic;

  if (!isSubtitleWorkflow) {
    return isAllowedTranslationModel(normalizedRequestedModel)
      ? normalizedRequestedModel
      : normalizeTranslationModel(undefined);
  }

  const effectivePhase =
    translationPhase === "review"
      ? "review"
      : translationPhase === "draft"
        ? "draft"
        : qualityMode === false
          ? "draft"
          : reviewByHeuristic
            ? "review"
            : "draft";

  if (effectivePhase !== "review") {
    return normalizeTranslationModel(undefined);
  }

  const prefersClaudeReview =
    canUseAnthropic &&
    (modelFamily === "claude" || isClaudeModel(normalizedRequestedModel));

  return prefersClaudeReview
    ? STAGE5_ANTHROPIC_REVIEW_TRANSLATION_MODEL
    : STAGE5_REVIEW_TRANSLATION_MODEL;
}

export function resolveTranslationReservationMaxCompletionTokens({
  model,
  reasoning,
}: {
  model: string;
  reasoning?: unknown;
}): number {
  const effort = String((reasoning as any)?.effort || "").trim().toLowerCase();
  if (isClaudeModel(model) && (effort === "medium" || effort === "high")) {
    return EXTENDED_TRANSLATION_MAX_COMPLETION_TOKENS;
  }
  return DEFAULT_TRANSLATION_MAX_COMPLETION_TOKENS;
}

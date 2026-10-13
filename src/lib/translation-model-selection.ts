import { isClaudeModel } from "./constants";
import { isAllowedTranslationModel, normalizeTranslationModel } from "./pricing";
import {
  STAGE5_CLAUDE_HAIKU_5_5_MODEL,
  STAGE5_CLAUDE_OPUS_5_5_MODEL,
  STAGE5_REVIEW_TRANSLATION_MODEL,
} from "./model-catalog";

export type TranslationModelFamily = "gpt" | "claude" | "auto";
export type TranslationPhase = "draft" | "review";

export type TranslationChatMessage = {
  role: string;
  content: string;
};

export const DEFAULT_TRANSLATION_MAX_COMPLETION_TOKENS = 16_000;
export const EXTENDED_TRANSLATION_MAX_COMPLETION_TOKENS = 32_000;
// Credit-mode review uses Anthropic's current Opus at the comparable price
// tier (2026-10-13 trial: about half the cost of GPT-5.5, more complete).
// GPT-5.5 is only the fallback when Anthropic is unavailable. Mirrors
// openai-relay resolveTranslationModel.
const STAGE5_ANTHROPIC_REVIEW_TRANSLATION_MODEL = STAGE5_CLAUDE_OPUS_5_5_MODEL;

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

  // Drafts: Haiku 5.5 when Anthropic is available (2026-10-13 trial: about a
  // tenth of GPT-5.1's cost); GPT-5.1 only as fallback. Mirrors the relay.
  if (effectivePhase !== "review") {
    return canUseAnthropic
      ? STAGE5_CLAUDE_HAIKU_5_5_MODEL
      : normalizeTranslationModel(undefined);
  }

  return canUseAnthropic
    ? STAGE5_ANTHROPIC_REVIEW_TRANSLATION_MODEL
    : STAGE5_REVIEW_TRANSLATION_MODEL;
}

const ALWAYS_THINKING_CLAUDE_MODELS = new Set<string>(["claude-opus-5-5"]);

export function resolveTranslationReservationMaxCompletionTokens({
  model,
  reasoning,
}: {
  model: string;
  reasoning?: unknown;
}): number {
  const effort = String((reasoning as any)?.effort || "").trim().toLowerCase();
  // Opus 5.5 thinks on every request (it can't be disabled), so it needs the
  // extended allowance. Mirrors openai-relay's claudeModelAlwaysThinks.
  if (
    isClaudeModel(model) &&
    (effort === "medium" ||
      effort === "high" ||
      effort === "xhigh" ||
      ALWAYS_THINKING_CLAUDE_MODELS.has(model))
  ) {
    return EXTENDED_TRANSLATION_MAX_COMPLETION_TOKENS;
  }
  return DEFAULT_TRANSLATION_MAX_COMPLETION_TOKENS;
}

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_STAGE5_TRANSLATION_MODEL,
  STAGE5_CLAUDE_OPUS_MODEL,
  STAGE5_LEGACY_REVIEW_TRANSLATION_MODEL,
  STAGE5_REVIEW_TRANSLATION_MODEL,
  normalizeStage5TranslationModel,
} from "../src/lib/model-catalog.ts";
import {
  normalizeTranslationBillingModel,
  tokensToCredits,
} from "../src/lib/pricing.ts";
import { resolveAuthoritativeTranslationModel } from "../src/lib/translation-model-selection.ts";

const REVIEW_MESSAGES = [
  {
    role: "system",
    content:
      "You are a subtitle reviewer. Output exactly @@SUB_LINE@@ entries with no commentary.",
  },
  {
    role: "user",
    content: "@@SUB_LINE@@ 1: Hello world",
  },
];

test("subtitle review uses Opus 5.5 whenever Anthropic is available, GPT-5.5 only as fallback", () => {
  for (const modelFamily of [undefined, "auto", "gpt", "claude"]) {
    for (const canUseAnthropic of [false, true]) {
      assert.equal(
        resolveAuthoritativeTranslationModel({
          requestedModel: "gpt-5.5",
          modelFamily,
          messages: REVIEW_MESSAGES,
          canUseAnthropic,
          translationPhase: "review",
          qualityMode: true,
        }),
        canUseAnthropic ? "claude-opus-5-5" : STAGE5_REVIEW_TRANSLATION_MODEL,
      );
    }
  }
});

test("legacy GPT-5.4 requests normalize to GPT-5.5", () => {
  assert.equal(
    normalizeStage5TranslationModel("gpt-5.4"),
    STAGE5_REVIEW_TRANSLATION_MODEL,
  );
});

test("legacy Claude Opus requests normalize to current Claude Opus", () => {
  for (const legacyModel of [
    "claude-opus-4-6",
    "claude-opus-4.6",
    "claude-opus-4-7",
    "claude-opus-4.7",
    "claude-opus-4.8",
  ]) {
    assert.equal(
      normalizeStage5TranslationModel(legacyModel),
      STAGE5_CLAUDE_OPUS_MODEL,
    );
    assert.equal(
      normalizeTranslationBillingModel(legacyModel),
      STAGE5_CLAUDE_OPUS_MODEL,
    );
  }
});

test("legacy GPT-5.4 billing keeps GPT-5.4 pricing", () => {
  assert.equal(
    normalizeTranslationBillingModel("gpt-5.4"),
    STAGE5_LEGACY_REVIEW_TRANSLATION_MODEL,
  );
  assert.equal(
    tokensToCredits({
      prompt: 1_000_000,
      completion: 0,
      model: "gpt-5.4",
    }),
    175_000,
  );
  assert.equal(
    tokensToCredits({
      prompt: 1_000_000,
      completion: 0,
      model: STAGE5_REVIEW_TRANSLATION_MODEL,
    }),
    350_000,
  );
});

test("subtitle review honors the Anthropic family hint when worker-side Anthropic review is available", () => {
  assert.equal(
    resolveAuthoritativeTranslationModel({
      requestedModel: "claude-opus-4-7",
      modelFamily: "claude",
      messages: REVIEW_MESSAGES,
      canUseAnthropic: true,
      translationPhase: "review",
      qualityMode: true,
    }),
    "claude-opus-5-5",
  );
});

test("subtitle review falls back to GPT-5.5 when worker-side Anthropic review is unavailable", () => {
  assert.equal(
    resolveAuthoritativeTranslationModel({
      requestedModel: "claude-opus-4-6",
      modelFamily: "claude",
      messages: REVIEW_MESSAGES,
      canUseAnthropic: false,
      translationPhase: "review",
      qualityMode: true,
    }),
    STAGE5_REVIEW_TRANSLATION_MODEL,
  );
});

test("subtitle drafts use Haiku 5.5 when Anthropic is available, the default model otherwise", () => {
  assert.equal(
    resolveAuthoritativeTranslationModel({
      requestedModel: "claude-opus-4-6",
      modelFamily: "claude",
      messages: [
        {
          role: "system",
          content:
            "You are a subtitle translator. Output exactly @@SUB_LINE@@ entries.",
        },
      ],
      canUseAnthropic: true,
      translationPhase: "draft",
      qualityMode: true,
    }),
    "claude-haiku-5-5",
  );
  assert.equal(
    resolveAuthoritativeTranslationModel({
      requestedModel: "gpt-5.1",
      messages: [],
      canUseAnthropic: false,
      translationPhase: "draft",
    }),
    DEFAULT_STAGE5_TRANSLATION_MODEL,
  );
});

test("non-subtitle translation requests still honor explicit allowed models", () => {
  assert.equal(
    resolveAuthoritativeTranslationModel({
      requestedModel: "claude-opus-4-7",
      modelFamily: "claude",
      messages: [{ role: "user", content: "Translate this paragraph." }],
      canUseAnthropic: true,
    }),
    STAGE5_CLAUDE_OPUS_MODEL,
  );
});

test("current Claude generation is priced and allowed; Sonnet 5 uses its list price", async () => {
  const { isAllowedTranslationModel, tokensToCredits } = await import("../src/lib/pricing.ts");
  const { resolveTranslationReservationMaxCompletionTokens, EXTENDED_TRANSLATION_MAX_COMPLETION_TOKENS } =
    await import("../src/lib/translation-model-selection.ts");
  assert.equal(isAllowedTranslationModel("claude-sonnet-5-5"), true);
  assert.equal(isAllowedTranslationModel("claude-opus-5-5"), true);
  // Same tokens cost the same on Sonnet 5 and Sonnet 5.5 ($2 / $10).
  const sonnet5 = tokensToCredits({ prompt: 1000, completion: 300, model: "claude-sonnet-5" });
  const sonnet55 = tokensToCredits({ prompt: 1000, completion: 300, model: "claude-sonnet-5-5" });
  assert.equal(sonnet5, sonnet55);
  // Opus 5.5 ($4 / $20) is cheaper than Opus 4.8 ($5 / $25).
  assert(
    tokensToCredits({ prompt: 1000, completion: 300, model: "claude-opus-5-5" }) <
      tokensToCredits({ prompt: 1000, completion: 300, model: "claude-opus-4-8" })
  );
  assert.equal(
    resolveTranslationReservationMaxCompletionTokens({ model: "claude-opus-5-5" }),
    EXTENDED_TRANSLATION_MAX_COMPLETION_TOKENS
  );
});

test("Gemini trial models are priced, allowed, UTF-8 estimated, and do not alter production defaults", async () => {
  const { isAllowedTranslationModel, tokensToCredits } = await import("../src/lib/pricing.ts");
  const { isGeminiModel, getProviderFromModel } = await import("../src/lib/constants.ts");
  const {
    DEFAULT_TRANSLATION_MAX_COMPLETION_TOKENS,
    EXTENDED_TRANSLATION_MAX_COMPLETION_TOKENS,
    resolveTranslationReservationMaxCompletionTokens,
  } = await import("../src/lib/translation-model-selection.ts");
  const { estimateTranslationPromptTokenReserve } = await import(
    "../src/lib/translation-token-estimator.ts"
  );

  for (const model of [
    "gemini-3.5-flash-lite",
    "gemini-4-hydrogen",
    "gemini-4-neon",
    "gemini-4-carbon",
  ]) {
    assert.equal(isAllowedTranslationModel(model), true, model);
    assert.equal(isGeminiModel(model), true, model);
    assert.equal(getProviderFromModel(model), "Gemini", model);
  }

  // Gemini 4 Neon ($3 / $15) is 25% cheaper than Opus 5.5 ($4 / $20).
  const neonCredits = tokensToCredits({
    prompt: 1_000_000,
    completion: 1_000_000,
    model: "gemini-4-neon",
  });
  const opusCredits = tokensToCredits({
    prompt: 1_000_000,
    completion: 1_000_000,
    model: "claude-opus-5-5",
  });
  assert.equal(neonCredits, Math.ceil((18 * 2) / (10 / 350_000)));
  assert(neonCredits < opusCredits);

  // Hydrogen ($1.50 / $7.50) is 25% cheaper than Sonnet 5.5 ($2 / $10).
  assert(
    tokensToCredits({ prompt: 100_000, completion: 50_000, model: "gemini-4-hydrogen" }) <
      tokensToCredits({ prompt: 100_000, completion: 50_000, model: "claude-sonnet-5-5" })
  );

  // Flash-Lite ($0.30 / $2.50) is cheaper than Hydrogen ($1.50 / $7.50).
  assert(
    tokensToCredits({ prompt: 100_000, completion: 50_000, model: "gemini-3.5-flash-lite" }) <
      tokensToCredits({ prompt: 100_000, completion: 50_000, model: "gemini-4-hydrogen" })
  );

  // Gemini 4 models always think -> extended reservation cap; Flash-Lite keeps default cap.
  assert.equal(
    resolveTranslationReservationMaxCompletionTokens({ model: "gemini-4-neon" }),
    EXTENDED_TRANSLATION_MAX_COMPLETION_TOKENS
  );
  assert.equal(
    resolveTranslationReservationMaxCompletionTokens({ model: "gemini-4-hydrogen" }),
    EXTENDED_TRANSLATION_MAX_COMPLETION_TOKENS
  );
  assert.equal(
    resolveTranslationReservationMaxCompletionTokens({ model: "gemini-4-carbon" }),
    EXTENDED_TRANSLATION_MAX_COMPLETION_TOKENS
  );
  assert.equal(
    resolveTranslationReservationMaxCompletionTokens({ model: "gemini-3.5-flash-lite" }),
    DEFAULT_TRANSLATION_MAX_COMPLETION_TOKENS
  );
  assert.equal(
    resolveTranslationReservationMaxCompletionTokens({
      model: "gemini-3.5-flash-lite",
      reasoning: { effort: "high" },
    }),
    EXTENDED_TRANSLATION_MAX_COMPLETION_TOKENS
  );

  // Gemini uses conservative UTF-8 prompt reserve matching Claude (not OpenAI tiktoken).
  const messages = [{ role: "user", content: "안녕하세요, 번역 테스트입니다." }];
  assert.equal(
    estimateTranslationPromptTokenReserve({ model: "gemini-4-neon", messages }),
    estimateTranslationPromptTokenReserve({ model: "claude-opus-5-5", messages })
  );

  // Production subtitle defaults stay on Haiku 5.5 / Opus 5.5 even if client asks for Gemini.
  assert.equal(
    resolveAuthoritativeTranslationModel({
      requestedModel: "gemini-4-neon",
      messages: REVIEW_MESSAGES,
      canUseAnthropic: true,
      translationPhase: "review",
      qualityMode: true,
    }),
    "claude-opus-5-5"
  );
});

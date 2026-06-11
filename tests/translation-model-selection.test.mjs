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

test("subtitle review defaults to GPT-5.5 on the Stage5 credit path", () => {
  for (const modelFamily of [undefined, "auto", "gpt"]) {
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
        STAGE5_REVIEW_TRANSLATION_MODEL,
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
    STAGE5_CLAUDE_OPUS_MODEL,
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

test("subtitle draft remains on the default Stage5 translation model", () => {
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

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_STAGE5_TRANSLATION_MODEL,
  STAGE5_REVIEW_TRANSLATION_MODEL,
} from "../src/lib/model-catalog.ts";
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

test("subtitle review always resolves to GPT-5.4 on the Stage5 credit path", () => {
  for (const modelFamily of [undefined, "auto", "gpt", "claude"]) {
    for (const canUseAnthropic of [false, true]) {
      assert.equal(
        resolveAuthoritativeTranslationModel({
          requestedModel: "claude-opus-4-6",
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
      requestedModel: "claude-opus-4-6",
      modelFamily: "claude",
      messages: [{ role: "user", content: "Translate this paragraph." }],
      canUseAnthropic: true,
    }),
    "claude-opus-4-6",
  );
});

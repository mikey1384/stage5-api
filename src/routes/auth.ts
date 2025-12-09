import { Hono } from "hono";
import { cors } from "hono/cors";
import { getUserByApiKey } from "../lib/db";
import {
  deductTranscriptionCredits,
  deductTranslationCredits,
  deductTTSCredits,
} from "../lib/db";
import type { TTSModel } from "../lib/pricing";

type Bindings = {
  RELAY_SECRET: string;
  DB: D1Database;
};

const router = new Hono<{ Bindings: Bindings }>();

// Add CORS middleware
router.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-Relay-Secret"],
  })
);

// All routes in this file use X-Relay-Secret (not bearer auth)
// This is called by the relay server, not directly by clients

/**
 * POST /authorize
 * Validates API key and returns device info
 * Called by relay before processing any AI request
 */
router.post("/authorize", async (c) => {
  const relaySecret = c.req.header("X-Relay-Secret");
  if (!relaySecret || relaySecret !== c.env.RELAY_SECRET) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const { apiKey } = await c.req.json();
    if (!apiKey) {
      return c.json({ error: "API key required" }, 400);
    }

    const user = await getUserByApiKey({ apiKey });
    if (!user) {
      return c.json({ error: "Invalid API key" }, 401);
    }

    if (user.credit_balance <= 0) {
      return c.json({ error: "Insufficient credits" }, 402);
    }

    console.log(
      `[auth/authorize] Authorized device ${user.device_id}, balance: ${user.credit_balance}`
    );

    return c.json({
      authorized: true,
      deviceId: user.device_id,
      creditBalance: user.credit_balance,
    });
  } catch (error: any) {
    console.error("[auth/authorize] Error:", error);
    return c.json({ error: error.message || "Authorization failed" }, 500);
  }
});

/**
 * POST /deduct
 * Generic credit deduction endpoint for all services
 * Accepts service type and appropriate metrics
 */
router.post("/deduct", async (c) => {
  const relaySecret = c.req.header("X-Relay-Secret");
  if (!relaySecret || relaySecret !== c.env.RELAY_SECRET) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await c.req.json();
    const { deviceId, service } = body;

    if (!deviceId || !service) {
      return c.json({ error: "deviceId and service required" }, 400);
    }

    let ok = false;

    switch (service) {
      case "transcription": {
        const { seconds, model = "elevenlabs-scribe" } = body;
        if (typeof seconds !== "number") {
          return c.json({ error: "seconds required for transcription" }, 400);
        }
        ok = await deductTranscriptionCredits({
          deviceId,
          seconds: Math.ceil(seconds),
          model,
        });
        console.log(
          `[auth/deduct] Transcription: ${Math.ceil(seconds)}s for device ${deviceId}`
        );
        break;
      }

      case "translation": {
        const { promptTokens, completionTokens, model = "gpt-5.1" } = body;
        if (
          typeof promptTokens !== "number" ||
          typeof completionTokens !== "number"
        ) {
          return c.json(
            { error: "promptTokens and completionTokens required for translation" },
            400
          );
        }
        ok = await deductTranslationCredits({
          deviceId,
          promptTokens,
          completionTokens,
          model,
        });
        console.log(
          `[auth/deduct] Translation: ${promptTokens}+${completionTokens} tokens (${model}) for device ${deviceId}`
        );
        break;
      }

      case "tts": {
        const { characters, model = "eleven_multilingual_v2" } = body;
        if (typeof characters !== "number") {
          return c.json({ error: "characters required for tts" }, 400);
        }
        ok = await deductTTSCredits({
          deviceId,
          characters,
          model: model as TTSModel,
        });
        console.log(
          `[auth/deduct] TTS: ${characters} chars (${model}) for device ${deviceId}`
        );
        break;
      }

      default:
        return c.json({ error: `Unknown service: ${service}` }, 400);
    }

    if (!ok) {
      console.error(`[auth/deduct] Failed to deduct credits for device ${deviceId}`);
      return c.json({ error: "Failed to deduct credits" }, 402);
    }

    return c.json({ success: true });
  } catch (error: any) {
    console.error("[auth/deduct] Error:", error);
    return c.json({ error: error.message || "Deduction failed" }, 500);
  }
});

export default router;

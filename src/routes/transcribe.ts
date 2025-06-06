import { Hono, Next } from "hono";
import { z } from "zod";
import OpenAI from "openai";
import { Context } from "hono";
import { getUserByApiKey, deductTranscriptionCredits } from "../lib/db";

type Bindings = {
  OPENAI_API_KEY: string;
  DB: D1Database;
};

type Variables = {
  user: {
    deviceId: string;
    creditBalance: number;
  };
};

const router = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Authentication middleware
router.use("*", async (c: Context, next: Next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized", message: "Missing API key" }, 401);
  }

  const apiKey = authHeader.substring(7);
  const user = await getUserByApiKey({ apiKey });

  if (!user) {
    return c.json({ error: "Unauthorized", message: "Invalid API key" }, 401);
  }

  c.set("user", {
    deviceId: user.device_id,
    creditBalance: user.credit_balance,
  });

  await next();
});

const transcribeSchema = z.object({
  model: z.string().default("whisper-1"),
  language: z.string().optional(),
});

router.post("/", async (c) => {
  const user = c.get("user");

  try {
    const formData = await c.req.formData();
    const file = formData.get("file");
    const model = formData.get("model")?.toString() || "whisper-1";
    const language = formData.get("language")?.toString();
    const response_format = "verbose_json";

    if (!(file instanceof File)) {
      return c.json({ error: "File is required" }, 400);
    }

    const openai = new OpenAI({
      apiKey: c.env.OPENAI_API_KEY,
    });

    const transcription = await openai.audio.transcriptions.create({
      file,
      model,
      language,
      response_format,
    });

    const duration = (transcription as any).duration;
    if (typeof duration !== "number") {
      console.error("Could not get duration from transcription result");
      return c.json(transcription); // Return result anyway, but don't charge
    }

    const success = await deductTranscriptionCredits({
      deviceId: user.deviceId,
      transcriptionDurationSeconds: duration,
    });

    if (!success) {
      // This case is important. If deduction fails, the user gets the
      // transcription but we log it as a billing failure.
      console.error(
        `CRITICAL: Failed to deduct credits for user ${user.deviceId} after a successful transcription.`
      );
      // You might want to return a special status or the transcription
      // but with a warning that their balance is too low for future jobs.
    }

    return c.json(transcription);
  } catch (error) {
    console.error("Error creating transcription:", error);
    return c.json(
      {
        error: "Failed to create transcription",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

export default router;

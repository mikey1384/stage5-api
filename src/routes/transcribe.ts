import { Hono, Next } from "hono";
import { z } from "zod";
import OpenAI from "openai";
import { Context } from "hono";
import { getUserByApiKey, deductTranscriptionCredits } from "../lib/db";
import { ALLOWED_TRANSCRIPTION_MODEL } from "../lib/constants";
import { cors } from "hono/cors";

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

// Add CORS middleware
router.use(
  "*",
  cors({
    origin: "*", // Restrict in production
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// OPTIONS early-exit (before auth middleware)
router.options("*", (c) => new Response("", { status: 204 }));

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
    const prompt = formData.get("prompt")?.toString();

    // Server-side model guard
    if (model !== ALLOWED_TRANSCRIPTION_MODEL) {
      return c.json(
        { error: `Only ${ALLOWED_TRANSCRIPTION_MODEL} is allowed` },
        400
      );
    }
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
      prompt,
      response_format,
      timestamp_granularities: ["word", "segment"],
    });

    /* -------------------------------------------------- */
    /* Deduct by audio length                             */
    /* -------------------------------------------------- */
    const rawDur =
      (transcription as any).duration ?? (transcription as any).approx_duration;
    if (typeof rawDur === "number") {
      const seconds = Math.ceil(rawDur);
      const ok = await deductTranscriptionCredits({
        deviceId: user.deviceId,
        seconds,
      });

      if (!ok) {
        return c.json(
          { error: "insufficient-credits" },
          402 /* Payment Required */
        );
      }
    } else {
      console.error(
        "Could not get duration from transcription result (checked both duration and approx_duration)"
      );
      // Return result anyway if we can't determine duration
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

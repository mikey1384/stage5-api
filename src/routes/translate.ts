import { Hono, Next } from "hono";
import { z } from "zod";
import OpenAI from "openai";
import { Context } from "hono";
import { getUserByApiKey, deductTranslationCredits } from "../lib/db";
import {
  ALLOWED_TRANSLATION_MODEL,
  MIN_TEMPERATURE,
  MAX_TEMPERATURE,
  DEFAULT_TEMPERATURE,
  API_ERRORS,
} from "../lib/constants";
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

// OPTIONS early-exit (before auth middleware) - explicit content-type for Safari
router.options(
  "*",
  (c) =>
    new Response("", {
      status: 204,
      headers: { "Content-Type": "text/plain" },
    })
);

// Authentication middleware
router.use("*", async (c: Context, next: Next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json(
      { error: API_ERRORS.UNAUTHORIZED, message: "Missing API key" },
      401
    );
  }

  const apiKey = authHeader.substring(7);
  const user = await getUserByApiKey({ apiKey });

  if (!user) {
    return c.json(
      { error: API_ERRORS.UNAUTHORIZED, message: "Invalid API key" },
      401
    );
  }

  c.set("user", {
    deviceId: user.device_id,
    creditBalance: user.credit_balance,
  });

  await next();
});

const translateSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["user", "system", "assistant"]),
      content: z.string(),
    })
  ),
  model: z.string(),
  temperature: z.number().optional(),
});

router.post("/", async (c) => {
  const user = c.get("user");

  try {
    const body = await c.req.json();
    const parsedBody = translateSchema.safeParse(body);

    if (!parsedBody.success) {
      return c.json(
        {
          error: API_ERRORS.INVALID_REQUEST,
          details: parsedBody.error.flatten(),
        },
        400
      );
    }

    const { messages, model, temperature } = parsedBody.data;

    // Server-side model guard
    if (model !== ALLOWED_TRANSLATION_MODEL) {
      return c.json(
        {
          error: API_ERRORS.INVALID_MODEL,
          message: `Only model ${ALLOWED_TRANSLATION_MODEL} is allowed`,
        },
        400
      );
    }

    // Temperature clamping for security
    const clampedTemperature = Math.min(
      Math.max(temperature ?? DEFAULT_TEMPERATURE, MIN_TEMPERATURE),
      MAX_TEMPERATURE
    );

    const openai = new OpenAI({
      apiKey: c.env.OPENAI_API_KEY,
    });

    const completion = await openai.chat.completions.create({
      messages,
      model,
      temperature: clampedTemperature,
    });

    // Note: OpenAI rate-limit headers would need to be accessed differently
    // via the raw fetch response, not available in this SDK abstraction

    /* -------------------------------------------------- */
    /* Track spend & deduct                               */
    /* -------------------------------------------------- */
    const usage = completion.usage; // { prompt_tokens: 123, completion_tokens: 456 }
    if (usage) {
      const ok = await deductTranslationCredits({
        deviceId: user.deviceId,
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
      });

      if (!ok) {
        return c.json(
          { error: API_ERRORS.INSUFFICIENT_CREDITS },
          402 /* Payment Required */
        );
      }
    } else {
      console.error("Could not get usage from translation result");
      // Return result anyway if we can't determine usage
    }

    return c.json(completion);
  } catch (error) {
    console.error("Error creating translation:", error);
    return c.json(
      {
        error: "Failed to create translation",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

export default router;

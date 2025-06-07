import { Hono, Next } from "hono";
import { z } from "zod";
import OpenAI from "openai";
import { Context } from "hono";
import { getUserByApiKey, deductTranslationCredits } from "../lib/db";
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
  "/translate",
  cors({
    origin: "*", // Restrict in production
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  })
);

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
      return c.json({ error: "Invalid request body" }, 400);
    }

    const { messages, model, temperature } = parsedBody.data;

    // Server-side model guard
    if (model !== "gpt-4.1") {
      return c.json({ error: "Only model gpt-4.1 is allowed" }, 400);
    }

    const openai = new OpenAI({
      apiKey: c.env.OPENAI_API_KEY,
    });

    const completion = await openai.chat.completions.create({
      messages,
      model,
      temperature,
    });

    const usage = completion.usage;
    if (!usage) {
      console.error("Could not get usage from translation result");
      return c.json(completion); // Return result anyway, but don't charge
    }

    const success = await deductTranslationCredits({
      deviceId: user.deviceId,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
    });

    if (!success) {
      console.error(
        `CRITICAL: Failed to deduct credits for user ${user.deviceId} after a successful translation.`
      );
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

import { Hono } from "hono";
import { z } from "zod";
import OpenAI from "openai";
import { cors } from "hono/cors";

type Bindings = {
  OPENAI_API_KEY: string;
};

const router = new Hono<{ Bindings: Bindings }>();

// Add CORS middleware
router.use(
  "/translate",
  cors({
    origin: "*", // Restrict in production
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  })
);

const translateSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string(),
    })
  ),
  model: z.string().default("gpt-4.1"),
  temperature: z.number().optional(),
});

router.post("/translate", async (c) => {
  try {
    const body = await c.req.json();
    const { messages, model, temperature } = translateSchema.parse(body);

    const openai = new OpenAI({
      apiKey: c.env.OPENAI_API_KEY,
    });

    const completion = await openai.chat.completions.create({
      messages,
      model,
      temperature,
    });

    return c.json(completion);
  } catch (error) {
    console.error("Error creating translation:", error);

    if (error instanceof z.ZodError) {
      return c.json(
        { error: "Invalid request data", details: error.errors },
        400
      );
    }

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

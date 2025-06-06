import { Hono } from "hono";
import { z } from "zod";
import OpenAI from "openai";
import { cors } from "hono/cors";

type Bindings = {
  OPENAI_API_KEY: string;
};

const router = new Hono<{ Bindings: Bindings }>();

// Add CORS middleware to allow requests from the Electron app's origin
router.use(
  "/transcribe",
  cors({
    origin: "*", // In production, you might want to restrict this to your app's origin
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  })
);

const transcribeSchema = z.object({
  model: z.string().default("whisper-1"),
  language: z.string().optional(),
});

router.post("/", async (c) => {
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

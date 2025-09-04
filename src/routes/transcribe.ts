import { Hono, Next } from "hono";
import { Context } from "hono";
import { getUserByApiKey, deductTranscriptionCredits } from "../lib/db";
import {
  ALLOWED_TRANSCRIPTION_MODELS,
  MAX_FILE_SIZE,
  API_ERRORS,
} from "../lib/constants";
import { cors } from "hono/cors";
import { makeOpenAI, makeGroq, callRelayServer } from "../lib/openai-config";

type Bindings = {
  OPENAI_API_KEY: string;
  GROQ_API_KEY: string;
  RELAY_SECRET: string;
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

router.post("/", async (c) => {
  const user = c.get("user");

  try {
    // Check if request was already aborted
    if (c.req.raw.signal?.aborted) {
      return c.json(
        { error: "Request cancelled", message: "Request was cancelled" },
        408 // Request Timeout - closest standard status for client cancellation
      );
    }

    const formData = await c.req.formData();
    const file = formData.get("file");
    const model = formData.get("model")?.toString() || "whisper-1";
    const language = formData.get("language")?.toString();
    const prompt = formData.get("prompt")?.toString();
    // New pricing is default; legacy flags are ignored

    if (!(file instanceof File)) {
      return c.json(
        { error: API_ERRORS.INVALID_REQUEST, message: "File is required" },
        400
      );
    }

    // File size limit check
    if (file.size > MAX_FILE_SIZE) {
      return c.json(
        {
          error: API_ERRORS.FILE_TOO_LARGE,
          message: `File size exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB limit`,
        },
        413
      );
    }

    // Server-side model guard
    if (!ALLOWED_TRANSCRIPTION_MODELS.includes(model)) {
      return c.json(
        {
          error: API_ERRORS.INVALID_MODEL,
          message: `Only ${ALLOWED_TRANSCRIPTION_MODELS.join(
            ", "
          )} are allowed`,
        },
        400
      );
    }

    // Check again before expensive operation
    if (c.req.raw.signal?.aborted) {
      return c.json(
        { error: "Request cancelled", message: "Request was cancelled" },
        408
      );
    }

    const response_format = "verbose_json";

    // Select client based on model
    let client;
    if (model === "whisper-1") {
      client = makeOpenAI(c);
    } else if (
      model === "whisper-large-v3" ||
      model === "whisper-large-v3-turbo"
    ) {
      client = makeGroq(c);
    } else {
      throw new Error("Unsupported model");
    }

    // Create a combined abort signal that responds to both client cancellation and server timeout
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, 300000); // 5 minute server-side timeout

    // Listen for client cancellation
    c.req.raw.signal?.addEventListener("abort", () => {
      clearTimeout(timeoutId);
      abortController.abort();
    });

    let transcription;
    let usedRelay = false;
    try {
      // Relay-first strategy: try relay before direct provider calls
      transcription = await callRelayServer({
        c,
        file,
        model,
        language: language ?? undefined,
        prompt: prompt ?? undefined,
        signal: abortController.signal,
      });
      usedRelay = true;
    } catch (error: any) {
      clearTimeout(timeoutId);

      // Handle cancellation/timeout
      if (error.name === "AbortError" || abortController.signal.aborted) {
        const wasCancelled = c.req.raw.signal?.aborted;
        return c.json(
          {
            error: wasCancelled ? "Request cancelled" : "Request timeout",
            message: wasCancelled
              ? "Request was cancelled by client"
              : "Request exceeded timeout limit",
          },
          408 // Request Timeout for both cases
        );
      }
      // If relay failed, fall back to direct provider call (OpenAI/Groq)
      try {
        transcription = await client.audio.transcriptions.create(
          {
            file,
            model,
            language,
            prompt,
            response_format,
            timestamp_granularities: ["word", "segment"],
          },
          {
            signal: abortController.signal,
          }
        );
      } catch (directError: any) {
        // Re-throw original relay error details if direct also fails
        console.error(
          "❌ Direct provider call also failed after relay:",
          directError
        );
        throw error;
      }
    } finally {
      clearTimeout(timeoutId);
    }

    // Final check before processing credits
    if (c.req.raw.signal?.aborted) {
      return c.json(
        { error: "Request cancelled", message: "Request was cancelled" },
        408
      );
    }

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
        model,
      });

      if (!ok) {
        return c.json(
          { error: API_ERRORS.INSUFFICIENT_CREDITS },
          402 /* Payment Required */
        );
      }
      console.log(
        `[transcribe] ${usedRelay ? "relay" : "direct"} success for device ${user.deviceId} (${model}) duration ${seconds}s`
      );
    } else {
      console.error(
        "Could not get duration from transcription result (checked both duration and approx_duration)"
      );
      // Return result anyway if we can't determine duration
    }

    return c.json(transcription as any);
  } catch (error) {
    console.error("Error creating transcription:", error);

    // Handle cancellation in catch block as well
    if (c.req.raw.signal?.aborted) {
      return c.json(
        { error: "Request cancelled", message: "Request was cancelled" },
        408
      );
    }

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

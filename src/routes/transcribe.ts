import { Hono, Context } from "hono";
import {
  deductTranscriptionCredits,
  createTranscriptionJob,
  getTranscriptionJob,
  setTranscriptionJobProcessing,
  storeTranscriptionJobResult,
  storeTranscriptionJobError,
  cleanupOldTranscriptionJobs,
} from "../lib/db";
import {
  ALLOWED_TRANSCRIPTION_MODELS,
  MAX_FILE_SIZE,
  API_ERRORS,
} from "../lib/constants";
import { cors } from "hono/cors";
import {
  makeOpenAI,
  callRelayServer,
  callElevenLabsTranscribeRelay,
  callElevenLabsTranscribeFromR2,
} from "../lib/openai-config";
import { bearerAuth, type AuthVariables } from "../lib/middleware";
import {
  createR2Client,
  generateUploadUrl,
  generateDownloadUrl,
  generateFileKey,
  deleteFile,
} from "../lib/r2-config";
import { v4 as uuidv4 } from "uuid";

type Bindings = {
  OPENAI_API_KEY: string;
  RELAY_SECRET: string;
  DB: D1Database;
  TRANSCRIPTION_BUCKET: R2Bucket;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
};

const router = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();

// Add CORS middleware
router.use(
  "*",
  cors({
    origin: "*", // Restrict in production
    allowMethods: ["POST", "GET", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Relay-Secret",
      "Idempotency-Key",
      "X-Idempotency-Key",
    ],
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

// ============================================================================
// Relay-authenticated endpoints (BEFORE bearer auth)
// These use X-Relay-Secret for authentication instead of bearer token
// ============================================================================

/**
 * POST /authorize
 * Called by relay to validate API key and check credits before transcription
 * Returns deviceId if authorized
 */
router.post("/authorize", async (c) => {
  // Verify relay secret
  const relaySecret = c.req.header("X-Relay-Secret");
  if (!relaySecret || relaySecret !== c.env.RELAY_SECRET) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const { apiKey } = await c.req.json();
    if (!apiKey) {
      return c.json({ error: "API key required" }, 400);
    }

    // Import and use the same auth logic as bearerAuth
    const { getUserByApiKey } = await import("../lib/db");
    const user = await getUserByApiKey({ apiKey });

    if (!user) {
      return c.json({ error: "Invalid API key" }, 401);
    }

    if (user.credit_balance <= 0) {
      return c.json({ error: "Insufficient credits" }, 402);
    }

    console.log(
      `[transcribe/authorize] Authorized device ${user.device_id}, balance: ${user.credit_balance}`
    );

    return c.json({
      authorized: true,
      deviceId: user.device_id,
      creditBalance: user.credit_balance,
    });
  } catch (error: any) {
    console.error("[transcribe/authorize] Error:", error);
    return c.json({ error: error.message || "Authorization failed" }, 500);
  }
});

/**
 * POST /deduct
 * Called by relay after successful transcription to deduct credits
 */
router.post("/deduct", async (c) => {
  // Verify relay secret
  const relaySecret = c.req.header("X-Relay-Secret");
  if (!relaySecret || relaySecret !== c.env.RELAY_SECRET) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const { deviceId, durationSeconds, idempotencyKey } = await c.req.json();
    if (!deviceId || typeof durationSeconds !== "number") {
      return c.json({ error: "deviceId and durationSeconds required" }, 400);
    }

    const ok = await deductTranscriptionCredits({
      deviceId,
      seconds: Math.ceil(durationSeconds),
      model: "elevenlabs-scribe",
      idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : undefined,
    });

    if (!ok) {
      console.error(
        `[transcribe/deduct] Failed to deduct credits for device ${deviceId}`
      );
      return c.json({ error: "Failed to deduct credits" }, 402);
    }

    console.log(
      `[transcribe/deduct] Deducted ${Math.ceil(durationSeconds)}s for device ${deviceId}`
    );

    return c.json({ success: true });
  } catch (error: any) {
    console.error("[transcribe/deduct] Error:", error);
    return c.json({ error: error.message || "Deduction failed" }, 500);
  }
});

/**
 * POST /webhook/:jobId
 * Called by the relay when transcription completes (legacy R2 flow)
 */
router.post("/webhook/:jobId", async (c) => {
  const jobId = c.req.param("jobId");

  // Verify relay secret (not bearer auth)
  const relaySecret = c.req.header("X-Relay-Secret");
  if (!relaySecret || relaySecret !== c.env.RELAY_SECRET) {
    console.error(`[transcribe/webhook] Invalid relay secret for job ${jobId}`);
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await c.req.json();
    const { success, result, error } = body as {
      success: boolean;
      result?: any;
      error?: string;
    };

    // Get the job to verify it exists and get device info
    const job = await getTranscriptionJob({ jobId });
    if (!job) {
      console.error(`[transcribe/webhook] Job ${jobId} not found`);
      return c.json({ error: "Job not found" }, 404);
    }

    if (job.status !== "processing") {
      console.warn(
        `[transcribe/webhook] Job ${jobId} not in processing state: ${job.status}`
      );
      // Still process it to avoid losing data
    }

    if (!success) {
      console.error(`[transcribe/webhook] Job ${jobId} failed: ${error}`);
      await storeTranscriptionJobError({
        jobId,
        message: error || "Transcription failed",
      });

      // Cleanup R2 file on failure
      if (job.file_key) {
        try {
          await deleteFile(c.env.TRANSCRIPTION_BUCKET, job.file_key);
        } catch (cleanupErr) {
          console.warn(
            `[transcribe/webhook] Failed to cleanup R2 file ${job.file_key}`
          );
        }
      }

      return c.json({ status: "error_recorded" });
    }

    // Deduct credits based on audio duration
    const rawDur = result?.duration ?? result?.approx_duration;
    if (typeof rawDur === "number") {
      const seconds = Math.ceil(rawDur);
      const ok = await deductTranscriptionCredits({
        deviceId: job.device_id,
        seconds,
        model: "elevenlabs-scribe",
        // Use jobId as a stable idempotency key so duplicate webhook deliveries can't double-charge.
        idempotencyKey: jobId,
      });

      if (!ok) {
        await storeTranscriptionJobError({
          jobId,
          message: "Insufficient credits",
        });
        return c.json({ status: "insufficient_credits" }, 402);
      }

      console.log(
        `[transcribe/webhook] Job ${jobId} completed, ${seconds}s transcribed`
      );

      await storeTranscriptionJobResult({
        jobId,
        result,
        durationSeconds: seconds,
      });
    } else {
      console.warn(
        `[transcribe/webhook] Job ${jobId} completed without duration`
      );
      await storeTranscriptionJobResult({
        jobId,
        result,
      });
    }

    // Cleanup R2 file
    if (job.file_key) {
      try {
        await deleteFile(c.env.TRANSCRIPTION_BUCKET, job.file_key);
        console.log(`[transcribe/webhook] Cleaned up R2 file: ${job.file_key}`);
      } catch (cleanupError) {
        console.warn(
          `[transcribe/webhook] Failed to cleanup R2 file: ${job.file_key}`
        );
      }
    }

    return c.json({ status: "success" });
  } catch (error: any) {
    console.error(`[transcribe/webhook] Error processing job ${jobId}:`, error);
    return c.json(
      { error: "Webhook processing failed", message: error.message },
      500
    );
  }
});

// Use shared auth middleware for all other routes
router.use("*", bearerAuth());

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
    const idempotencyKey =
      c.req.header("Idempotency-Key") || c.req.header("X-Idempotency-Key");

    // Only whisper-1 (OpenAI) is supported
    const client = makeOpenAI(c);

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
    let usedElevenLabs = false;

    // Try ElevenLabs Scribe first (highest quality), then OpenAI relay, then direct
    try {
      transcription = await callElevenLabsTranscribeRelay({
        c,
        file,
        language: language ?? undefined,
        signal: abortController.signal,
        idempotencyKey: idempotencyKey ?? undefined,
      });
      usedRelay = true;
      usedElevenLabs = true;
      console.log(
        `[transcribe] ElevenLabs Scribe succeeded for device ${user.deviceId}`
      );
    } catch (elevenLabsError: any) {
      // Handle cancellation/timeout
      if (
        elevenLabsError.name === "AbortError" ||
        abortController.signal.aborted
      ) {
        clearTimeout(timeoutId);
        const wasCancelled = c.req.raw.signal?.aborted;
        return c.json(
          {
            error: wasCancelled ? "Request cancelled" : "Request timeout",
            message: wasCancelled
              ? "Request was cancelled by client"
              : "Request exceeded timeout limit",
          },
          408
        );
      }

      console.warn(
        `[transcribe] ElevenLabs failed (${elevenLabsError?.message}), trying OpenAI relay...`
      );

      // Fall back to OpenAI relay
      try {
        transcription = await callRelayServer({
          c,
          file,
          model,
          language: language ?? undefined,
          prompt: prompt ?? undefined,
          signal: abortController.signal,
        });
        usedRelay = true;
      } catch (relayError: any) {
        // Handle cancellation/timeout
        if (
          relayError.name === "AbortError" ||
          abortController.signal.aborted
        ) {
          clearTimeout(timeoutId);
          const wasCancelled = c.req.raw.signal?.aborted;
          return c.json(
            {
              error: wasCancelled ? "Request cancelled" : "Request timeout",
              message: wasCancelled
                ? "Request was cancelled by client"
                : "Request exceeded timeout limit",
            },
            408
          );
        }

        console.warn(
          `[transcribe] OpenAI relay failed (${relayError?.message}), trying direct...`
        );

        // If relay failed, fall back to direct provider call
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
          console.error("❌ All transcription attempts failed:", directError);
          throw relayError; // Re-throw relay error for better messaging
        }
      }
    }
    clearTimeout(timeoutId);

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
        idempotencyKey: idempotencyKey ?? undefined,
      });

      if (!ok) {
        return c.json(
          { error: API_ERRORS.INSUFFICIENT_CREDITS },
          402 /* Payment Required */
        );
      }
      const provider = usedElevenLabs ? "ElevenLabs" : "OpenAI";
      console.log(
        `[transcribe] ${usedRelay ? "relay" : "direct"} success for device ${
          user.deviceId
        } model=${model} provider=${provider} duration=${seconds}s`
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

// ============================================================================
// R2-based Large File Transcription Flow
// ============================================================================

/**
 * POST /upload-url
 * Request a presigned URL for uploading a large audio file to R2
 */
router.post("/upload-url", async (c) => {
  const user = c.get("user");

  // Cleanup old jobs in background (non-blocking)
  c.executionCtx.waitUntil(cleanupOldTranscriptionJobs({ maxAgeHours: 24 }));

  try {
    const body = await c.req.json().catch(() => ({}));
    const language = body.language as string | undefined;
    const contentType = body.contentType || "audio/webm";
    const fileSizeMB = body.fileSizeMB as number | undefined;

    // Validate file size if provided (max 500MB)
    if (fileSizeMB && fileSizeMB > 500) {
      return c.json(
        {
          error: API_ERRORS.FILE_TOO_LARGE,
          message: "File size exceeds 500MB limit",
        },
        413
      );
    }

    // Check user has credits before allowing upload
    if (user.creditBalance <= 0) {
      return c.json(
        {
          error: API_ERRORS.INSUFFICIENT_CREDITS,
          message: "Insufficient credits",
        },
        402
      );
    }

    // Generate job ID and file key
    const jobId = uuidv4();
    const fileKey = generateFileKey(user.deviceId, jobId);

    // Create R2 client and generate presigned URL
    const r2Client = createR2Client({
      accountId: c.env.R2_ACCOUNT_ID,
      accessKeyId: c.env.R2_ACCESS_KEY_ID,
      secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
    });

    const uploadUrl = await generateUploadUrl(r2Client, fileKey, contentType);

    // Store job in D1 database
    await createTranscriptionJob({
      jobId,
      deviceId: user.deviceId,
      fileKey,
      language,
    });

    console.log(
      `[transcribe/upload-url] Created job ${jobId} for device ${user.deviceId}`
    );

    return c.json({
      jobId,
      uploadUrl,
      fileKey,
      expiresIn: 3600, // 1 hour
    });
  } catch (error) {
    console.error("[transcribe/upload-url] Error:", error);
    return c.json(
      {
        error: "Failed to generate upload URL",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

/**
 * POST /process/:jobId
 * Start processing a file that was uploaded to R2
 * Uses webhook pattern to ensure results are never lost
 */
router.post("/process/:jobId", async (c) => {
  const user = c.get("user");
  const jobId = c.req.param("jobId");

  try {
    const job = await getTranscriptionJob({ jobId });
    if (!job) {
      return c.json({ error: "Job not found" }, 404);
    }

    if (job.device_id !== user.deviceId) {
      return c.json({ error: "Unauthorized" }, 403);
    }

    if (job.status !== "pending_upload") {
      return c.json(
        { error: "Job already processing or completed", status: job.status },
        400
      );
    }

    // Verify file exists in R2
    const r2Object = await c.env.TRANSCRIPTION_BUCKET.head(job.file_key!);
    if (!r2Object) {
      return c.json(
        { error: "File not found in storage. Please upload first." },
        400
      );
    }

    // Update job status in D1
    await setTranscriptionJobProcessing({ jobId });

    // Generate a download URL for the relay to fetch the file
    const r2Client = createR2Client({
      accountId: c.env.R2_ACCOUNT_ID,
      accessKeyId: c.env.R2_ACCESS_KEY_ID,
      secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
    });
    const downloadUrl = await generateDownloadUrl(r2Client, job.file_key!);

    // Build the webhook URL for the relay to call when done
    // The relay will POST the result to this URL, avoiding Worker timeout issues
    const webhookUrl = `https://api.stage5.tools/transcribe/webhook/${jobId}`;

    console.log(
      `[transcribe/process] Starting processing for job ${jobId} (${(
        r2Object.size /
        1024 /
        1024
      ).toFixed(1)}MB) with webhook callback`
    );

    // Call relay with webhook URL - relay returns immediately
    // When transcription completes, relay will POST to webhookUrl
    await callElevenLabsTranscribeFromR2({
      c,
      r2Url: downloadUrl,
      language: job.language ?? undefined,
      webhookUrl,
    });

    return c.json({
      jobId: job.job_id,
      status: "processing",
      message: "Processing started",
    });
  } catch (error) {
    console.error("[transcribe/process] Error:", error);
    return c.json(
      {
        error: "Failed to start processing",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

/**
 * GET /status/:jobId
 * Check the status of a transcription job
 */
router.get("/status/:jobId", async (c) => {
  const user = c.get("user");
  const jobId = c.req.param("jobId");

  const job = await getTranscriptionJob({ jobId });
  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  if (job.device_id !== user.deviceId) {
    return c.json({ error: "Unauthorized" }, 403);
  }

  if (job.status === "completed") {
    // Parse and return the result
    const result = job.result ? JSON.parse(job.result) : null;
    return c.json({
      jobId: job.job_id,
      status: job.status,
      result,
    });
  }

  if (job.status === "failed") {
    return c.json({
      jobId: job.job_id,
      status: job.status,
      error: job.error,
    });
  }

  return c.json({
    jobId: job.job_id,
    status: job.status,
  });
});

export default router;

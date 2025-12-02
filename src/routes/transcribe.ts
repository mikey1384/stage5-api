import { Hono, Context } from "hono";
import { deductTranscriptionCredits } from "../lib/db";
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

// Use shared auth middleware
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

import {
  createR2Client,
  generateUploadUrl,
  generateDownloadUrl,
  generateFileKey,
  deleteFile,
} from "../lib/r2-config";
import { v4 as uuidv4 } from "uuid";

// In-memory job storage (in production, use D1 or KV for persistence)
interface TranscriptionJob {
  id: string;
  deviceId: string;
  status: "pending_upload" | "processing" | "completed" | "failed";
  fileKey: string;
  language?: string;
  createdAt: number;
  result?: any;
  error?: string;
}

const transcriptionJobs = new Map<string, TranscriptionJob>();

// Cleanup old jobs periodically (older than 1 hour)
function cleanupOldJobs() {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of transcriptionJobs) {
    if (job.createdAt < oneHourAgo) {
      transcriptionJobs.delete(id);
    }
  }
}

/**
 * POST /upload-url
 * Request a presigned URL for uploading a large audio file to R2
 */
router.post("/upload-url", async (c) => {
  const user = c.get("user");
  cleanupOldJobs();

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

    // Store job in memory
    const job: TranscriptionJob = {
      id: jobId,
      deviceId: user.deviceId,
      status: "pending_upload",
      fileKey,
      language,
      createdAt: Date.now(),
    };
    transcriptionJobs.set(jobId, job);

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
 */
router.post("/process/:jobId", async (c) => {
  const user = c.get("user");
  const jobId = c.req.param("jobId");

  try {
    const job = transcriptionJobs.get(jobId);
    if (!job) {
      return c.json({ error: "Job not found" }, 404);
    }

    if (job.deviceId !== user.deviceId) {
      return c.json({ error: "Unauthorized" }, 403);
    }

    if (job.status !== "pending_upload") {
      return c.json(
        { error: "Job already processing or completed", status: job.status },
        400
      );
    }

    // Verify file exists in R2
    const r2Object = await c.env.TRANSCRIPTION_BUCKET.head(job.fileKey);
    if (!r2Object) {
      return c.json(
        { error: "File not found in storage. Please upload first." },
        400
      );
    }

    // Update job status
    job.status = "processing";

    // Generate a download URL for the relay to fetch the file
    const r2Client = createR2Client({
      accountId: c.env.R2_ACCOUNT_ID,
      accessKeyId: c.env.R2_ACCESS_KEY_ID,
      secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
    });
    const downloadUrl = await generateDownloadUrl(r2Client, job.fileKey);

    console.log(
      `[transcribe/process] Starting processing for job ${jobId} (${(
        r2Object.size /
        1024 /
        1024
      ).toFixed(1)}MB)`
    );

    // Start async processing
    c.executionCtx.waitUntil(processTranscriptionJob(c, job, downloadUrl));

    return c.json({
      jobId: job.id,
      status: job.status,
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

  const job = transcriptionJobs.get(jobId);
  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  if (job.deviceId !== user.deviceId) {
    return c.json({ error: "Unauthorized" }, 403);
  }

  if (job.status === "completed") {
    // Return result and clean up
    const result = job.result;
    // Don't delete job immediately - let client poll a few times
    return c.json({
      jobId: job.id,
      status: job.status,
      result,
    });
  }

  if (job.status === "failed") {
    return c.json({
      jobId: job.id,
      status: job.status,
      error: job.error,
    });
  }

  return c.json({
    jobId: job.id,
    status: job.status,
  });
});

/**
 * Process a transcription job asynchronously
 */
async function processTranscriptionJob(
  c: Context<{ Bindings: Bindings; Variables: AuthVariables }>,
  job: TranscriptionJob,
  downloadUrl: string
) {
  try {
    // Call relay to transcribe from R2 URL
    const transcription = await callElevenLabsTranscribeFromR2({
      c,
      r2Url: downloadUrl,
      language: job.language,
    });

    // Deduct credits based on audio duration
    const rawDur = transcription.duration ?? transcription.approx_duration;
    if (typeof rawDur === "number") {
      const seconds = Math.ceil(rawDur);
      const ok = await deductTranscriptionCredits({
        deviceId: job.deviceId,
        seconds,
        model: "elevenlabs-scribe",
      });

      if (!ok) {
        job.status = "failed";
        job.error = "Insufficient credits";
        return;
      }

      console.log(
        `[transcribe/process] Job ${job.id} completed, ${seconds}s transcribed`
      );
    }

    job.status = "completed";
    job.result = transcription;

    // Cleanup R2 file
    try {
      await deleteFile(c.env.TRANSCRIPTION_BUCKET, job.fileKey);
      console.log(`[transcribe/process] Cleaned up R2 file: ${job.fileKey}`);
    } catch (cleanupError) {
      console.warn(
        `[transcribe/process] Failed to cleanup R2 file: ${job.fileKey}`,
        cleanupError
      );
    }
  } catch (error: any) {
    console.error(`[transcribe/process] Job ${job.id} failed:`, error);
    job.status = "failed";
    job.error = error.message || "Transcription failed";

    // Still try to cleanup R2 file on failure
    try {
      await deleteFile(c.env.TRANSCRIPTION_BUCKET, job.fileKey);
    } catch (cleanupErr) {
      console.warn(
        `[transcribe/process] Failed to cleanup R2 file ${job.fileKey}:`,
        cleanupErr
      );
    }
  }
}

export default router;

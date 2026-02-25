import { Hono, Context } from "hono";
import crypto from "node:crypto";
import { z } from "zod";
import { cors } from "hono/cors";
import { API_ERRORS, getProviderFromModel } from "../lib/constants";
import { isAllowedTranslationModel, normalizeTranslationModel } from "../lib/pricing";
import {
  createTranslationJob,
  deleteTranslationJob,
  setTranslationJobProcessing,
  resetTranslationJobRelay,
  getTranslationJob,
  storeTranslationJobResult,
  storeTranslationJobError,
  markTranslationJobCredited,
  deductTranslationCredits,
  TranslationJobRecord,
} from "../lib/db";
import {
  submitTranslationRelayJob,
  fetchRelayTranslationStatus,
  RelayHttpError,
} from "../lib/openai-config";
import { bearerAuth, type AuthVariables } from "../lib/middleware";

/** Common HTTP error status codes used in this route */
type ErrorStatusCode = 400 | 402 | 404 | 500 | 502 | 503;

type Bindings = {
  OPENAI_API_KEY: string;
  DB: D1Database;
};

const router = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();

router.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["POST", "GET", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

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

const translateSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["user", "system", "assistant"]),
      content: z.string(),
    })
  ),
  model: z.string().optional(),
  modelFamily: z.enum(["gpt", "claude", "auto"]).optional(),
  reasoning: z.any().optional(),
  translationPhase: z.enum(["draft", "review"]).optional(),
  qualityMode: z.boolean().optional(),
});

router.post("/", async (c) => {
  const user = c.get("user");

  if (c.req.raw.signal?.aborted) {
    return c.json(
      { error: "Request cancelled", message: "Request was cancelled" },
      408
    );
  }

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

  const {
    messages,
    model: requestedModel,
    modelFamily,
    reasoning,
    translationPhase,
    qualityMode,
  } = parsedBody.data;

  // Forward caller model for non-subtitle compatibility. Relay remains authoritative
  // for subtitle draft/review phases via translationPhase + modelFamily.
  const normalizedRequestedModel = normalizeTranslationModel(requestedModel);

  const jobId = crypto.randomUUID();
  const payload = {
    mode: "chat" as const,
    messages,
    model: normalizedRequestedModel,
    modelFamily,
    reasoning,
    translationPhase,
    qualityMode,
  };

  try {
    await createTranslationJob({
      jobId,
      deviceId: user.deviceId,
      model: normalizedRequestedModel,
      payload,
    });
  } catch (error: any) {
    return c.json(
      {
        error: "Failed to queue translation",
        message: error?.message || "Failed to create translation job",
      },
      { status: 500 }
    );
  }

  try {
    const submission = await submitTranslationRelayJob({
      c,
      payload,
      signal: c.req.raw.signal,
    });

    if (submission.type === "completed") {
      const completion = submission.result;
      const persistResult = await persistCompletion({
        jobId,
        jobOwner: user.deviceId,
        payload,
        completion,
      });

      if (persistResult.status === "error") {
        return c.json(
          { error: persistResult.message },
          { status: persistResult.code }
        );
      }

      return c.json(completion);
    }

    await setTranslationJobProcessing({
      jobId,
      relayJobId: submission.relayJobId,
    });

    return c.json(
      { jobId, status: submission.status ?? "queued" },
      { status: 202 }
    );
  } catch (error: any) {
    if (error instanceof RelayHttpError && error.status === 400) {
      try {
        await deleteTranslationJob({ jobId });
      } catch (cleanupError) {
        console.warn(
          `[translate] Failed to cleanup job ${jobId} after relay 400:`,
          cleanupError
        );
      }
      return c.json(
        {
          error: API_ERRORS.INVALID_REQUEST,
          message: getRelayClientErrorMessage(error.body),
        },
        400
      );
    }

    const message = error?.message || "Failed to submit translation job";
    await storeTranslationJobError({ jobId, message });
    return c.json(
      {
        error: "Failed to queue translation",
        message,
      },
      { status: 500 }
    );
  }
});

router.get("/result/:jobId", async (c) => {
  const user = c.get("user");
  const jobId = c.req.param("jobId");

  const job = await getTranslationJob({ jobId });
  if (!job || job.device_id !== user.deviceId) {
    return c.json({ error: "Job not found" }, { status: 404 });
  }

  if (job.status === "completed") {
    return respondWithJobResult(c, job);
  }

  if (job.status === "failed") {
    return respondWithJobFailure(c, job);
  }

  const payload = parseJobPayload(job);
  if (!payload) {
    await storeTranslationJobError({ jobId, message: "Invalid payload" });
    return c.json({ error: "Translation job failed" }, { status: 500 });
  }

  const syncResult = await syncJobWithRelay({
    c,
    job,
    payload,
    signal: c.req.raw.signal,
  });

  if (syncResult?.status === "error") {
    return c.json(
      { error: syncResult.message },
      { status: syncResult.code }
    );
  }

  const refreshed = await getTranslationJob({ jobId });
  if (!refreshed) {
    return c.json({ error: "Job not found" }, { status: 404 });
  }

  if (refreshed.status === "completed") {
    return respondWithJobResult(c, refreshed);
  }

  if (refreshed.status === "failed") {
    return respondWithJobFailure(c, refreshed);
  }

  return c.json({ status: refreshed.status }, { status: 202 });
});

export default router;

function parseJobPayload(
  job: TranslationJobRecord
): Record<string, unknown> | null {
  try {
    if (!job.payload) return null;
    return JSON.parse(job.payload);
  } catch {
    return null;
  }
}

function respondWithJobResult(c: Context<any>, job: TranslationJobRecord) {
  try {
    const parsed = job.result ? JSON.parse(job.result) : {};
    return c.json(parsed);
  } catch {
    return c.json({ error: "Malformed translation result" }, { status: 500 });
  }
}

function respondWithJobFailure(c: Context<any>, job: TranslationJobRecord) {
  const message = job.error || "Translation job failed";
  const status: ErrorStatusCode = job.error === "insufficient-credits" ? 402 : 500;
  return c.json({ error: message }, { status });
}

async function syncJobWithRelay({
  c,
  job,
  payload,
  signal,
}: {
  c: Context<any>;
  job: TranslationJobRecord;
  payload: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<
  { status: "ok" } | { status: "error"; code: ErrorStatusCode; message: string }
> {
  if (!job.relay_job_id) {
    try {
      const submission = await submitTranslationRelayJob({
        c,
        payload,
        signal,
      });

      if (submission.type === "completed") {
        const completion = submission.result;
        const persistResult = await persistCompletion({
          jobId: job.job_id,
          jobOwner: job.device_id,
          payload,
          completion,
        });

        if (persistResult.status === "error") {
          return persistResult;
        }

        return { status: "ok" };
      }

      await setTranslationJobProcessing({
        jobId: job.job_id,
        relayJobId: submission.relayJobId,
      });
      return { status: "ok" };
    } catch (error: any) {
      await storeTranslationJobError({
        jobId: job.job_id,
        message: error?.message || "Failed to submit translation job",
      });
      return {
        status: "error",
        code: 500,
        message: error?.message || "Translation job failed",
      };
    }
  }

  try {
    const status = await fetchRelayTranslationStatus({
      c,
      relayJobId: job.relay_job_id!,
      signal,
    });

    if (status.type === "processing") {
      await setTranslationJobProcessing({
        jobId: job.job_id,
        relayJobId: job.relay_job_id,
      });
      return { status: "ok" };
    }

    if (status.type === "completed") {
      const completion = status.result;
      const persistResult = await persistCompletion({
        jobId: job.job_id,
        jobOwner: job.device_id,
        payload,
        completion,
      });

      if (persistResult.status === "error") {
        return persistResult;
      }

      return { status: "ok" };
    }

    if (status.type === "not_found") {
      await resetTranslationJobRelay({ jobId: job.job_id });
      const resubmission = await submitTranslationRelayJob({
        c,
        payload,
        signal,
      });

      if (resubmission.type === "completed") {
        const completion = resubmission.result;
        const persistResult = await persistCompletion({
          jobId: job.job_id,
          jobOwner: job.device_id,
          payload,
          completion,
        });

        if (persistResult.status === "error") {
          return persistResult;
        }

        return { status: "ok" };
      }

      await setTranslationJobProcessing({
        jobId: job.job_id,
        relayJobId: resubmission.relayJobId,
      });
      return { status: "ok" };
    }

    if (status.type === "error") {
      await storeTranslationJobError({
        jobId: job.job_id,
        message: status.message,
      });
      return { status: "error", code: 500, message: status.message };
    }

    return { status: "ok" };
  } catch (error: any) {
    await storeTranslationJobError({
      jobId: job.job_id,
      message: error?.message || "Relay status check failed",
    });
    return {
      status: "error",
      code: 500,
      message: error?.message || "Relay status check failed",
    };
  }
}

async function persistCompletion({
  jobId,
  jobOwner,
  payload,
  completion,
}: {
  jobId: string;
  jobOwner: string;
  payload: Record<string, unknown>;
  completion: any;
}): Promise<
  { status: "ok" } | { status: "error"; code: ErrorStatusCode; message: string }
> {
  const usage = completion?.usage ?? {};
  const promptTokens =
    typeof usage?.prompt_tokens === "number"
      ? usage.prompt_tokens
      : estimatePromptTokens(payload);
  const completionTokens =
    typeof usage?.completion_tokens === "number"
      ? usage.completion_tokens
      : estimateCompletionTokens(completion);

  await storeTranslationJobResult({
    jobId,
    result: completion,
    promptTokens,
    completionTokens,
  });

  const job = await getTranslationJob({ jobId });
  if (!job) {
    return { status: "error", code: 500, message: "Job not found" };
  }

  if (!job.credited) {
    const rawCompletionModel =
      typeof completion?.model === "string" ? completion.model.trim() : "";
    if (!rawCompletionModel) {
      await storeTranslationJobError({
        jobId,
        message: "unsupported-billing-model:missing-completion-model",
      });
      return {
        status: "error",
        code: 500,
        message: "unsupported-billing-model",
      };
    }

    const billedModel = normalizeTranslationModel(rawCompletionModel);
    if (!isAllowedTranslationModel(billedModel)) {
      await storeTranslationJobError({
        jobId,
        message: `unsupported-billing-model:${billedModel}`,
      });
      return {
        status: "error",
        code: 500,
        message: "unsupported-billing-model",
      };
    }

    const ok = await deductTranslationCredits({
      deviceId: jobOwner,
      promptTokens: promptTokens ?? 0,
      completionTokens: completionTokens ?? 0,
      model: billedModel,
    });

    if (!ok) {
      await storeTranslationJobError({
        jobId,
        message: "insufficient-credits",
      });
      return { status: "error", code: 402, message: "insufficient-credits" };
    }

    await markTranslationJobCredited({ jobId });

    const provider = getProviderFromModel(billedModel);
    console.log(
      `[translate] success for device ${jobOwner} model=${billedModel} provider=${provider} promptTokens=${promptTokens} completionTokens=${completionTokens}`
    );
  }

  return { status: "ok" };
}

function estimatePromptTokens(payload: Record<string, unknown>): number {
  try {
    const raw = JSON.stringify(payload?.messages ?? payload ?? {});
    return Math.ceil(raw.length / 4);
  } catch {
    return 0;
  }
}

function estimateCompletionTokens(completion: any): number {
  try {
    const content = completion?.choices?.[0]?.message?.content ?? "";
    return Math.ceil(String(content).length / 4);
  } catch {
    return 0;
  }
}

function getRelayClientErrorMessage(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody);
    if (typeof parsed?.error === "string" && parsed.error.trim()) {
      return parsed.error.trim();
    }
    if (typeof parsed?.message === "string" && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // Ignore parse errors and return raw message fallback.
  }
  return rawBody?.trim?.() || "Invalid request";
}

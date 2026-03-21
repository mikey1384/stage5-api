import crypto from "node:crypto";
import { buildScopedIdempotencyKey } from "./request-utils";

const DIRECT_TRANSCRIPTION_RESERVATION_SCOPE = "transcribe-direct-billing-v1";

type DirectTranscriptionQualityMode = boolean | "auto";

async function hashFileContents(file: File): Promise<string> {
  const hasher = crypto.createHash("sha256");
  const stream = file.stream();
  if (stream && typeof (stream as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    try {
      let readResult = await reader.read();
      while (!readResult.done) {
        const { value } = readResult;
        if (value && value.byteLength > 0) {
          hasher.update(value);
        }
        readResult = await reader.read();
      }
      return hasher.digest("hex").slice(0, 32);
    } finally {
      reader.releaseLock?.();
    }
  }

  hasher.update(new Uint8Array(await file.arrayBuffer()));
  return hasher.digest("hex").slice(0, 32);
}

export async function buildDirectTranscriptionIdentityPayload({
  deviceId,
  file,
  requestedModel,
  qualityMode,
  language,
  prompt,
}: {
  deviceId: string;
  file: File;
  requestedModel: string;
  qualityMode: DirectTranscriptionQualityMode;
  language: string | null;
  prompt: string | null;
}): Promise<Record<string, unknown>> {
  return {
    deviceId,
    fileFingerprint: await hashFileContents(file),
    fileSizeBytes: file.size,
    requestedModel,
    qualityMode,
    language,
    prompt,
  };
}

export async function buildDirectTranscriptionReservationKey({
  requestIdempotencyKey,
  deviceId,
  file,
  requestedModel,
  qualityMode,
  language,
  prompt,
}: {
  requestIdempotencyKey?: string;
  deviceId: string;
  file: File;
  requestedModel: string;
  qualityMode: DirectTranscriptionQualityMode;
  language: string | null;
  prompt: string | null;
}): Promise<string | undefined> {
  const trimmedIdempotencyKey = (requestIdempotencyKey || "").trim();
  if (!trimmedIdempotencyKey) {
    return undefined;
  }

  return buildScopedIdempotencyKey({
    scope: DIRECT_TRANSCRIPTION_RESERVATION_SCOPE,
    requestIdempotencyKey: trimmedIdempotencyKey,
    payload: await buildDirectTranscriptionIdentityPayload({
      deviceId,
      file,
      requestedModel,
      qualityMode,
      language,
      prompt,
    }),
  });
}

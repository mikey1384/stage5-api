import {
  deductTranscriptionCredits,
  deductTranslationCredits,
  deductTTSCredits,
  getUserByApiKey,
} from "./db";
import {
  isAllowedTranslationModel,
  normalizeTranslationModel,
  type TTSModel,
} from "./pricing";
import {
  DEFAULT_STAGE5_TRANSLATION_MODEL,
  STAGE5_ELEVENLABS_SCRIBE_MODEL,
} from "./model-catalog";

export const RELAY_BILLING_ROUTE_SEGMENTS = {
  AUTHORIZE: "/authorize",
  DEDUCT: "/deduct",
} as const;

export const RELAY_BILLING_API_PATHS = {
  AUTHORIZE: `/auth${RELAY_BILLING_ROUTE_SEGMENTS.AUTHORIZE}`,
  DEDUCT: `/auth${RELAY_BILLING_ROUTE_SEGMENTS.DEDUCT}`,
  LEGACY_TRANSCRIBE_AUTHORIZE: `/transcribe${RELAY_BILLING_ROUTE_SEGMENTS.AUTHORIZE}`,
  LEGACY_TRANSCRIBE_DEDUCT: `/transcribe${RELAY_BILLING_ROUTE_SEGMENTS.DEDUCT}`,
} as const;

export const RELAY_BILLING_SERVICES = {
  TRANSCRIPTION: "transcription",
  TRANSLATION: "translation",
  TTS: "tts",
} as const;

type RelayBillingService =
  (typeof RELAY_BILLING_SERVICES)[keyof typeof RELAY_BILLING_SERVICES];

type RelayAuthorizeSuccess = {
  ok: true;
  deviceId: string;
  creditBalance: number;
};

type RelayHttpStatus = 400 | 401 | 402 | 500;

type RelayAuthorizeFailure = {
  ok: false;
  status: RelayHttpStatus;
  error: string;
};

export type RelayAuthorizeResult = RelayAuthorizeSuccess | RelayAuthorizeFailure;

type RelayDeductSuccess = {
  ok: true;
  logMessage: string;
};

type RelayDeductFailure = {
  ok: false;
  status: RelayHttpStatus;
  error: string;
};

export type RelayDeductResult = RelayDeductSuccess | RelayDeductFailure;

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeRelayIdempotencyKey(value: unknown): string | undefined {
  const normalized = asNonEmptyString(value);
  return normalized || undefined;
}

function failAuthorize(
  status: RelayHttpStatus,
  error: string
): RelayAuthorizeFailure {
  return { ok: false, status, error };
}

function failDeduct(status: RelayHttpStatus, error: string): RelayDeductFailure {
  return { ok: false, status, error };
}

export function hasValidRelaySecret(
  relaySecretHeader: string | undefined,
  expectedRelaySecret: string
): boolean {
  return Boolean(relaySecretHeader && relaySecretHeader === expectedRelaySecret);
}

export async function authorizeRelayApiKey(
  apiKeyRaw: unknown
): Promise<RelayAuthorizeResult> {
  const apiKey = asNonEmptyString(apiKeyRaw);
  if (!apiKey) {
    return failAuthorize(400, "API key required");
  }

  const user = await getUserByApiKey({ apiKey });
  if (!user) {
    return failAuthorize(401, "Invalid API key");
  }

  if (user.credit_balance <= 0) {
    return failAuthorize(402, "Insufficient credits");
  }

  return {
    ok: true,
    deviceId: user.device_id,
    creditBalance: user.credit_balance,
  };
}

export async function deductRelayCredits(
  rawBody: unknown
): Promise<RelayDeductResult> {
  const body = asObject(rawBody);
  if (!body) {
    return failDeduct(400, "Invalid request body");
  }

  const deviceId = asNonEmptyString(body.deviceId);
  const service = asNonEmptyString(body.service).toLowerCase() as RelayBillingService;
  const idempotencyKey = normalizeRelayIdempotencyKey(body.idempotencyKey);

  if (!deviceId || !service) {
    return failDeduct(400, "deviceId and service required");
  }

  switch (service) {
    case RELAY_BILLING_SERVICES.TRANSCRIPTION: {
      const seconds = asFiniteNumber(body.seconds);
      if (seconds === null) {
        return failDeduct(400, "seconds required for transcription");
      }

      const model = asNonEmptyString(body.model) || STAGE5_ELEVENLABS_SCRIBE_MODEL;
      const ok = await deductTranscriptionCredits({
        deviceId,
        seconds: Math.ceil(seconds),
        model,
        idempotencyKey,
      });
      if (!ok) return failDeduct(402, "Failed to deduct credits");
      return {
        ok: true,
        logMessage: `Transcription: ${Math.ceil(seconds)}s (${model}) for device ${deviceId}${idempotencyKey ? ` (idempotencyKey=${idempotencyKey})` : ""}`,
      };
    }

    case RELAY_BILLING_SERVICES.TRANSLATION: {
      const promptTokens = asFiniteNumber(body.promptTokens);
      const completionTokens = asFiniteNumber(body.completionTokens);
      if (promptTokens === null || completionTokens === null) {
        return failDeduct(
          400,
          "promptTokens and completionTokens required for translation"
        );
      }

      const normalizedModel = normalizeTranslationModel(
        String(body.model || DEFAULT_STAGE5_TRANSLATION_MODEL)
      );
      if (!isAllowedTranslationModel(normalizedModel)) {
        return failDeduct(400, `Unsupported translation model: ${normalizedModel}`);
      }

      const ok = await deductTranslationCredits({
        deviceId,
        promptTokens,
        completionTokens,
        model: normalizedModel,
        idempotencyKey,
      });
      if (!ok) return failDeduct(402, "Failed to deduct credits");
      return {
        ok: true,
        logMessage: `Translation: ${promptTokens}+${completionTokens} tokens (${normalizedModel}) for device ${deviceId}${idempotencyKey ? ` (idempotencyKey=${idempotencyKey})` : ""}`,
      };
    }

    case RELAY_BILLING_SERVICES.TTS: {
      const characters = asFiniteNumber(body.characters);
      if (characters === null) {
        return failDeduct(400, "characters required for tts");
      }

      const model = (asNonEmptyString(body.model) || "eleven_multilingual_v2") as TTSModel;
      const ok = await deductTTSCredits({
        deviceId,
        characters,
        model,
        idempotencyKey,
      });
      if (!ok) return failDeduct(402, "Failed to deduct credits");
      return {
        ok: true,
        logMessage: `TTS: ${characters} chars (${model}) for device ${deviceId}${idempotencyKey ? ` (idempotencyKey=${idempotencyKey})` : ""}`,
      };
    }

    default:
      return failDeduct(400, `Unknown service: ${service}`);
  }
}

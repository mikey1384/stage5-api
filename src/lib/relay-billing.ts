import {
  getUserByApiKey,
  confirmExistingBillingReservation,
  findBillingReservationByRelayRetryHint,
  increaseBillingReservation,
  mergeBillingReservationMeta,
  reserveBillingCredits,
  releaseBillingReservation,
  settleBillingReservation,
} from "./db";
import {
  charactersToCredits,
  isAllowedTranslationModel,
  normalizeTranslationModel,
  secondsToCredits,
  tokensToCredits,
  type TTSModel,
  webSearchCallsToCredits,
} from "./pricing";
import {
  DEFAULT_STAGE5_TRANSLATION_MODEL,
  STAGE5_ELEVENLABS_SCRIBE_MODEL,
  STAGE5_TTS_MODEL_STANDARD,
} from "./model-catalog";

export const RELAY_BILLING_ROUTE_SEGMENTS = {
  AUTHORIZE: "/authorize",
  CONFIRM: "/confirm",
  RESERVE: "/reserve",
  FINALIZE: "/finalize",
  PERSIST: "/persist",
  RELEASE: "/release",
  REPLAY_STORE: "/replay-store",
  REPLAY_LOAD: "/replay-load",
  REPLAY_DELETE: "/replay-delete",
} as const;

export const RELAY_BILLING_API_PATHS = {
  AUTHORIZE: `/auth${RELAY_BILLING_ROUTE_SEGMENTS.AUTHORIZE}`,
  CONFIRM: `/auth${RELAY_BILLING_ROUTE_SEGMENTS.CONFIRM}`,
  RESERVE: `/auth${RELAY_BILLING_ROUTE_SEGMENTS.RESERVE}`,
  FINALIZE: `/auth${RELAY_BILLING_ROUTE_SEGMENTS.FINALIZE}`,
  PERSIST: `/auth${RELAY_BILLING_ROUTE_SEGMENTS.PERSIST}`,
  RELEASE: `/auth${RELAY_BILLING_ROUTE_SEGMENTS.RELEASE}`,
  REPLAY_STORE: `/auth${RELAY_BILLING_ROUTE_SEGMENTS.REPLAY_STORE}`,
  REPLAY_LOAD: `/auth${RELAY_BILLING_ROUTE_SEGMENTS.REPLAY_LOAD}`,
  REPLAY_DELETE: `/auth${RELAY_BILLING_ROUTE_SEGMENTS.REPLAY_DELETE}`,
} as const;

export const RELAY_BILLING_SERVICES = {
  TRANSCRIPTION: "transcription",
  TRANSLATION: "translation",
  TTS: "tts",
} as const;

type RelayBillingService =
  (typeof RELAY_BILLING_SERVICES)[keyof typeof RELAY_BILLING_SERVICES];

type RelayHttpStatus = 400 | 401 | 402 | 409 | 500;

type RelayAuthorizeSuccess = {
  ok: true;
  deviceId: string;
  creditBalance: number;
};

type RelayFailure = {
  ok: false;
  status: RelayHttpStatus;
  error: string;
};

export type RelayAuthorizeResult = RelayAuthorizeSuccess | RelayFailure;

type RelayMutationSuccess = {
  ok: true;
  logMessage: string;
  status: "reserved" | "duplicate" | "settled" | "released" | "persisted";
  reservationStatus?: "reserved" | "settled" | "released";
  reservationMeta?: unknown;
  reservationUpdatedAt?: string;
};

export type RelayMutationResult = RelayMutationSuccess | RelayFailure;

type TranslationReserveInput = {
  promptTokens: number;
  maxCompletionTokens: number;
  model: string;
  webSearchCalls: number;
};

type TranslationFinalizeInput = {
  promptTokens: number;
  completionTokens: number;
  model: string;
  webSearchCalls: number;
};

type TranscriptionSpendInput = {
  seconds: number;
  model: string;
};

type TtsSpendInput = {
  characters: number;
  model: TTSModel;
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function fail(status: RelayHttpStatus, error: string): RelayFailure {
  return { ok: false, status, error };
}

function parseReservationMeta(raw: string | null | undefined): unknown {
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function mergeMeta(
  baseMeta: Record<string, unknown>,
  extraMeta: unknown
): Record<string, unknown> {
  const extraObject = asObject(extraMeta);
  return extraObject ? { ...baseMeta, ...extraObject } : baseMeta;
}

function getDuplicateReservationDetails(
  reservation:
    | {
        status?: string | null;
        meta?: string | null;
        updated_at?: string | null;
      }
    | null
    | undefined
): Pick<
  RelayMutationSuccess,
  "reservationStatus" | "reservationMeta" | "reservationUpdatedAt"
> {
  const reservationStatus =
    reservation?.status === "reserved" ||
    reservation?.status === "settled" ||
    reservation?.status === "released"
      ? reservation.status
      : undefined;
  const reservationMeta = parseReservationMeta(reservation?.meta);

  return {
    ...(reservationStatus ? { reservationStatus } : {}),
    ...(typeof reservationMeta !== "undefined" ? { reservationMeta } : {}),
    ...(typeof reservation?.updated_at === "string" && reservation.updated_at.trim()
      ? { reservationUpdatedAt: reservation.updated_at }
      : {}),
  };
}

function normalizedTranslationModel(raw: unknown): string {
  return normalizeTranslationModel(String(raw || DEFAULT_STAGE5_TRANSLATION_MODEL));
}

function parseTranslationReserveInput(
  body: Record<string, unknown>
): TranslationReserveInput | RelayFailure {
  const promptTokens = asFiniteNumber(body.promptTokens);
  const maxCompletionTokens = asFiniteNumber(body.maxCompletionTokens);
  const webSearchCallsRaw = asFiniteNumber(body.webSearchCalls);
  const model = normalizedTranslationModel(body.model);

  if (promptTokens === null || maxCompletionTokens === null) {
    return fail(
      400,
      "promptTokens and maxCompletionTokens required for translation reserve"
    );
  }
  if (!isAllowedTranslationModel(model)) {
    return fail(400, `Unsupported translation model: ${model}`);
  }

  return {
    promptTokens: Math.max(0, Math.ceil(promptTokens)),
    maxCompletionTokens: Math.max(0, Math.ceil(maxCompletionTokens)),
    model,
    webSearchCalls:
      webSearchCallsRaw === null ? 0 : Math.max(0, Math.ceil(webSearchCallsRaw)),
  };
}

function parseTranslationFinalizeInput(
  body: Record<string, unknown>
): TranslationFinalizeInput | RelayFailure {
  const promptTokens = asFiniteNumber(body.promptTokens);
  const completionTokens = asFiniteNumber(body.completionTokens);
  const webSearchCallsRaw = asFiniteNumber(body.webSearchCalls);
  const model = normalizedTranslationModel(body.model);

  if (promptTokens === null || completionTokens === null) {
    return fail(
      400,
      "promptTokens and completionTokens required for translation finalize"
    );
  }
  if (!isAllowedTranslationModel(model)) {
    return fail(400, `Unsupported translation model: ${model}`);
  }

  return {
    promptTokens: Math.max(0, Math.ceil(promptTokens)),
    completionTokens: Math.max(0, Math.ceil(completionTokens)),
    model,
    webSearchCalls:
      webSearchCallsRaw === null ? 0 : Math.max(0, Math.ceil(webSearchCallsRaw)),
  };
}

function parseTranscriptionInput(
  body: Record<string, unknown>
): TranscriptionSpendInput | RelayFailure {
  const seconds = asFiniteNumber(body.seconds);
  if (seconds === null) {
    return fail(400, "seconds required for transcription");
  }

  return {
    seconds: Math.max(0, Math.ceil(seconds)),
    model: asNonEmptyString(body.model) || STAGE5_ELEVENLABS_SCRIBE_MODEL,
  };
}

function parseTtsInput(body: Record<string, unknown>): TtsSpendInput | RelayFailure {
  const characters = asFiniteNumber(body.characters);
  if (characters === null) {
    return fail(400, "characters required for tts");
  }

  return {
    characters: Math.max(0, Math.ceil(characters)),
    model: (asNonEmptyString(body.model) || STAGE5_TTS_MODEL_STANDARD) as TTSModel,
  };
}

function translationSpend({
  promptTokens,
  completionTokens,
  model,
  webSearchCalls,
}: TranslationFinalizeInput): number {
  return (
    tokensToCredits({
      prompt: promptTokens,
      completion: completionTokens,
      model,
    }) +
    webSearchCallsToCredits({ calls: webSearchCalls })
  );
}

export function estimateTranslationReservationCredits({
  promptTokens,
  maxCompletionTokens,
  model = DEFAULT_STAGE5_TRANSLATION_MODEL,
  webSearchCalls = 0,
}: {
  promptTokens: number;
  maxCompletionTokens: number;
  model?: string;
  webSearchCalls?: number;
}): number {
  return (
    tokensToCredits({
      prompt: Math.max(0, Math.ceil(promptTokens)),
      completion: Math.max(0, Math.ceil(maxCompletionTokens)),
      model: normalizedTranslationModel(model),
    }) +
    webSearchCallsToCredits({ calls: Math.max(0, Math.ceil(webSearchCalls)) })
  );
}

export function estimateTranscriptionCredits({
  seconds,
  model,
}: {
  seconds: number;
  model: string;
}): number {
  return secondsToCredits({ seconds: Math.max(0, Math.ceil(seconds)), model });
}

export function estimateTTSCredits({
  characters,
  model,
}: {
  characters: number;
  model: TTSModel;
}): number {
  return charactersToCredits({
    characters: Math.max(0, Math.ceil(characters)),
    model,
  });
}

export function hasValidRelaySecret(
  relaySecretHeader: string | undefined,
  expectedRelaySecret: string
): boolean {
  return Boolean(relaySecretHeader && relaySecretHeader === expectedRelaySecret);
}

export async function authorizeRelayApiKey(
  rawBody: unknown
): Promise<RelayAuthorizeResult> {
  const body = asObject(rawBody);
  const apiKey = asNonEmptyString(body?.apiKey ?? rawBody);
  if (!apiKey) {
    return fail(400, "API key required");
  }

  const user = await getUserByApiKey({ apiKey });
  if (!user) {
    return fail(401, "Invalid API key");
  }
  const creditBalance = Number.isFinite(user.credit_balance)
    ? user.credit_balance
    : 0;
  if (creditBalance <= 0) {
    const service = asNonEmptyString(body?.service).toLowerCase();
    const clientIdempotencyKey = asNonEmptyString(body?.clientIdempotencyKey);
    if (!service || !clientIdempotencyKey) {
      return fail(402, "Insufficient credits");
    }

    const retryReservation = await findBillingReservationByRelayRetryHint({
      deviceId: user.device_id,
      service,
      clientIdempotencyKey,
    });
    if (!retryReservation) {
      return fail(402, "Insufficient credits");
    }
  }

  return {
    ok: true,
    deviceId: user.device_id,
    creditBalance,
  };
}

export async function reserveRelayCredits(
  rawBody: unknown
): Promise<RelayMutationResult> {
  const body = asObject(rawBody);
  if (!body) {
    return fail(400, "Invalid request body");
  }

  const deviceId = asNonEmptyString(body.deviceId);
  const service = asNonEmptyString(body.service).toLowerCase() as RelayBillingService;
  const requestKey = asNonEmptyString(body.requestKey);

  if (!deviceId || !service || !requestKey) {
    return fail(400, "deviceId, service, and requestKey required");
  }

  switch (service) {
    case RELAY_BILLING_SERVICES.TRANSLATION: {
      const parsed = parseTranslationReserveInput(body);
      if ("ok" in parsed) return parsed;
      const spend = estimateTranslationReservationCredits(parsed);
      const result = await reserveBillingCredits({
        deviceId,
        service,
        requestKey,
        spend,
        reason: "TRANSLATE_RESERVE",
        meta: mergeMeta({ ...parsed, spend }, body.meta),
      });
      if (!result.ok) {
        return fail(402, "Insufficient credits");
      }
      return {
        ok: true,
        status: result.status === "duplicate" ? "duplicate" : "reserved",
        ...(result.status === "duplicate"
          ? getDuplicateReservationDetails(result.reservation)
          : {}),
        logMessage:
          result.status === "duplicate"
            ? `Translation reservation duplicate for device ${deviceId} requestKey=${requestKey}`
            : `Translation reservation ${spend} credits for device ${deviceId} requestKey=${requestKey}`,
      };
    }

    case RELAY_BILLING_SERVICES.TRANSCRIPTION: {
      const parsed = parseTranscriptionInput(body);
      if ("ok" in parsed) return parsed;
      const spend = estimateTranscriptionCredits(parsed);
      const result = await reserveBillingCredits({
        deviceId,
        service,
        requestKey,
        spend,
        reason: "TRANSCRIBE_RESERVE",
        meta: mergeMeta({ ...parsed, spend }, body.meta),
      });
      if (!result.ok) {
        return fail(402, "Insufficient credits");
      }
      return {
        ok: true,
        status: result.status === "duplicate" ? "duplicate" : "reserved",
        ...(result.status === "duplicate"
          ? getDuplicateReservationDetails(result.reservation)
          : {}),
        logMessage:
          result.status === "duplicate"
            ? `Transcription reservation duplicate for device ${deviceId} requestKey=${requestKey}`
            : `Transcription reservation ${spend} credits for device ${deviceId} requestKey=${requestKey}`,
      };
    }

    case RELAY_BILLING_SERVICES.TTS: {
      const parsed = parseTtsInput(body);
      if ("ok" in parsed) return parsed;
      const spend = estimateTTSCredits(parsed);
      const result = await reserveBillingCredits({
        deviceId,
        service,
        requestKey,
        spend,
        reason: "DUB_RESERVE",
        meta: mergeMeta({ ...parsed, spend }, body.meta),
      });
      if (!result.ok) {
        return fail(402, "Insufficient credits");
      }
      return {
        ok: true,
        status: result.status === "duplicate" ? "duplicate" : "reserved",
        ...(result.status === "duplicate"
          ? getDuplicateReservationDetails(result.reservation)
          : {}),
        logMessage:
          result.status === "duplicate"
            ? `TTS reservation duplicate for device ${deviceId} requestKey=${requestKey}`
            : `TTS reservation ${spend} credits for device ${deviceId} requestKey=${requestKey}`,
      };
    }

    default:
      return fail(400, `Unknown service: ${service}`);
  }
}

export async function confirmRelayReservation(
  rawBody: unknown
): Promise<RelayMutationResult> {
  const body = asObject(rawBody);
  if (!body) {
    return fail(400, "Invalid request body");
  }

  const deviceId = asNonEmptyString(body.deviceId);
  const service = asNonEmptyString(body.service).toLowerCase() as RelayBillingService;
  const requestKey = asNonEmptyString(body.requestKey);

  if (!deviceId || !service || !requestKey) {
    return fail(400, "deviceId, service, and requestKey required");
  }

  const result = await confirmExistingBillingReservation({
    deviceId,
    service,
    requestKey,
  });
  if (!result.ok) {
    return fail(409, result.error);
  }

  if (service === RELAY_BILLING_SERVICES.TRANSCRIPTION) {
    const parsed = parseTranscriptionInput(body);
    if (!("ok" in parsed)) {
      const requiredSpend = estimateTranscriptionCredits(parsed);
      if (requiredSpend > result.reservation.reserved_spend) {
        const increased = await increaseBillingReservation({
          deviceId,
          service,
          requestKey,
          requiredSpend,
          reason: "TRANSCRIBE_RESERVE_TOPUP",
          meta: mergeMeta(
            {
              ...parsed,
              spend: requiredSpend,
              previousReservedSpend: result.reservation.reserved_spend,
            },
            body.meta
          ),
        });
        if (!increased.ok) {
          return fail(
            increased.error === "insufficient-credits" ? 402 : 409,
            increased.error
          );
        }
        if (increased.status === "duplicate") {
          return fail(409, "reservation-not-active");
        }
      }
    }
  }

  const confirmMeta = asObject(body.meta);
  if (confirmMeta) {
    const merged = await mergeBillingReservationMeta({
      deviceId,
      service,
      requestKey,
      meta: confirmMeta,
    });
    if (!merged.ok) {
      return fail(409, merged.error);
    }
  }

  return {
    ok: true,
    status: "reserved",
    logMessage: `Confirmed reservation for device ${deviceId} requestKey=${requestKey}`,
  };
}

export async function finalizeRelayCredits(
  rawBody: unknown
): Promise<RelayMutationResult> {
  const body = asObject(rawBody);
  if (!body) {
    return fail(400, "Invalid request body");
  }

  const deviceId = asNonEmptyString(body.deviceId);
  const service = asNonEmptyString(body.service).toLowerCase() as RelayBillingService;
  const requestKey = asNonEmptyString(body.requestKey);

  if (!deviceId || !service || !requestKey) {
    return fail(400, "deviceId, service, and requestKey required");
  }

  switch (service) {
    case RELAY_BILLING_SERVICES.TRANSLATION: {
      const parsed = parseTranslationFinalizeInput(body);
      if ("ok" in parsed) return parsed;
      const spend = translationSpend(parsed);
      const result = await settleBillingReservation({
        deviceId,
        service,
        requestKey,
        actualSpend: spend,
        reason: "TRANSLATE",
        meta: mergeMeta({ ...parsed, spend }, body.meta),
      });
      if (!result.ok) {
        return fail(
          result.error === "actual-spend-exceeds-reserve" ? 409 : 400,
          result.error
        );
      }
      return {
        ok: true,
        status: result.status === "duplicate" ? "duplicate" : "settled",
        ...(result.status === "duplicate"
          ? getDuplicateReservationDetails(result.reservation)
          : {}),
        logMessage:
          result.status === "duplicate"
            ? `Translation finalize duplicate for device ${deviceId} requestKey=${requestKey}`
            : `Translation finalized ${spend} credits for device ${deviceId} requestKey=${requestKey}`,
      };
    }

    case RELAY_BILLING_SERVICES.TRANSCRIPTION: {
      const parsed = parseTranscriptionInput(body);
      if ("ok" in parsed) return parsed;
      const spend = estimateTranscriptionCredits(parsed);
      const result = await settleBillingReservation({
        deviceId,
        service,
        requestKey,
        actualSpend: spend,
        reason: "TRANSCRIBE",
        meta: mergeMeta({ ...parsed, spend }, body.meta),
      });
      if (!result.ok) {
        return fail(
          result.error === "actual-spend-exceeds-reserve" ? 409 : 400,
          result.error
        );
      }
      return {
        ok: true,
        status: result.status === "duplicate" ? "duplicate" : "settled",
        ...(result.status === "duplicate"
          ? getDuplicateReservationDetails(result.reservation)
          : {}),
        logMessage:
          result.status === "duplicate"
            ? `Transcription finalize duplicate for device ${deviceId} requestKey=${requestKey}`
            : `Transcription finalized ${spend} credits for device ${deviceId} requestKey=${requestKey}`,
      };
    }

    case RELAY_BILLING_SERVICES.TTS: {
      const parsed = parseTtsInput(body);
      if ("ok" in parsed) return parsed;
      const spend = estimateTTSCredits(parsed);
      const result = await settleBillingReservation({
        deviceId,
        service,
        requestKey,
        actualSpend: spend,
        reason: "DUB",
        meta: mergeMeta({ ...parsed, spend }, body.meta),
      });
      if (!result.ok) {
        return fail(
          result.error === "actual-spend-exceeds-reserve" ? 409 : 400,
          result.error
        );
      }
      return {
        ok: true,
        status: result.status === "duplicate" ? "duplicate" : "settled",
        ...(result.status === "duplicate"
          ? getDuplicateReservationDetails(result.reservation)
          : {}),
        logMessage:
          result.status === "duplicate"
            ? `TTS finalize duplicate for device ${deviceId} requestKey=${requestKey}`
            : `TTS finalized ${spend} credits for device ${deviceId} requestKey=${requestKey}`,
      };
    }

    default:
      return fail(400, `Unknown service: ${service}`);
  }
}

export async function releaseRelayCredits(
  rawBody: unknown
): Promise<RelayMutationResult> {
  const body = asObject(rawBody);
  if (!body) {
    return fail(400, "Invalid request body");
  }

  const deviceId = asNonEmptyString(body.deviceId);
  const service = asNonEmptyString(body.service).toLowerCase() as RelayBillingService;
  const requestKey = asNonEmptyString(body.requestKey);

  if (!deviceId || !service || !requestKey) {
    return fail(400, "deviceId, service, and requestKey required");
  }

  const result = await releaseBillingReservation({
    deviceId,
    service,
    requestKey,
    reason:
      service === RELAY_BILLING_SERVICES.TRANSLATION
        ? "TRANSLATE"
        : service === RELAY_BILLING_SERVICES.TRANSCRIPTION
          ? "TRANSCRIBE"
          : "DUB",
    meta: body.meta,
  });
  if (!result.ok) {
    return fail(400, result.error);
  }

  return {
    ok: true,
    status: result.status === "duplicate" ? "duplicate" : "released",
    ...(result.status === "duplicate"
      ? getDuplicateReservationDetails(result.reservation)
      : {}),
    logMessage:
      result.status === "duplicate"
        ? `Release duplicate for device ${deviceId} requestKey=${requestKey}`
        : `Released reservation for device ${deviceId} requestKey=${requestKey}`,
  };
}

export async function persistRelayReservationMeta(
  rawBody: unknown
): Promise<RelayMutationResult> {
  const body = asObject(rawBody);
  if (!body) {
    return fail(400, "Invalid request body");
  }

  const deviceId = asNonEmptyString(body.deviceId);
  const service = asNonEmptyString(body.service).toLowerCase() as RelayBillingService;
  const requestKey = asNonEmptyString(body.requestKey);

  if (!deviceId || !service || !requestKey) {
    return fail(400, "deviceId, service, and requestKey required");
  }

  const result = await mergeBillingReservationMeta({
    deviceId,
    service,
    requestKey,
    meta: body.meta,
  });
  if (!result.ok) {
    return fail(409, result.error);
  }

  return {
    ok: true,
    status: "persisted",
    ...getDuplicateReservationDetails(result.reservation),
    logMessage: `Persisted reservation meta for device ${deviceId} requestKey=${requestKey}`,
  };
}

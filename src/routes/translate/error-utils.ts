import { RelayHttpError } from "../../lib/openai-config";
import { API_ERRORS } from "../../lib/constants";

export type ErrorStatusCode = 400 | 402 | 404 | 500 | 502 | 503;

const TRANSLATION_ERROR_STATUS_CODES = new Set<ErrorStatusCode>([
  400,
  402,
  404,
  500,
  502,
  503,
]);
const TRANSLATION_JOB_ERROR_PREFIX = "__s5_translation_error__:";

export function encodeTranslationJobError({
  message,
  statusCode,
}: {
  message: string;
  statusCode?: ErrorStatusCode;
}): string {
  const normalizedMessage =
    typeof message === "string" && message.trim().length > 0
      ? message.trim()
      : "Translation job failed";

  if (
    typeof statusCode !== "number" ||
    !TRANSLATION_ERROR_STATUS_CODES.has(statusCode)
  ) {
    return normalizedMessage;
  }

  return `${TRANSLATION_JOB_ERROR_PREFIX}${JSON.stringify({
    message: normalizedMessage,
    statusCode,
  })}`;
}

export function parseTranslationJobError(
  rawError: string | null | undefined
): { message: string; status: ErrorStatusCode } {
  if (!rawError) {
    return { message: "Translation job failed", status: 500 };
  }

  if (rawError === API_ERRORS.INSUFFICIENT_CREDITS) {
    return { message: rawError, status: 402 };
  }

  if (rawError.startsWith(TRANSLATION_JOB_ERROR_PREFIX)) {
    const payload = rawError.slice(TRANSLATION_JOB_ERROR_PREFIX.length);
    try {
      const parsed = JSON.parse(payload) as {
        message?: unknown;
        statusCode?: unknown;
      };
      const parsedMessage =
        typeof parsed.message === "string" && parsed.message.trim().length > 0
          ? parsed.message.trim()
          : "Translation job failed";
      const parsedStatus = Number(parsed.statusCode);
      if (TRANSLATION_ERROR_STATUS_CODES.has(parsedStatus as ErrorStatusCode)) {
        return {
          message: parsedMessage,
          status: parsedStatus as ErrorStatusCode,
        };
      }
      return { message: parsedMessage, status: 500 };
    } catch {
      return { message: "Translation job failed", status: 500 };
    }
  }

  return { message: rawError, status: 500 };
}

export function isRelaySubmitTerminalStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403 || status === 404;
}

export function mapRelaySubmitTerminalFailure(error: RelayHttpError): {
  message: string;
  statusCode: ErrorStatusCode;
} {
  if (error.status === 400) {
    return {
      message: getRelayClientErrorMessage(error.body),
      statusCode: 400,
    };
  }

  if (error.status === 401 || error.status === 403) {
    return {
      message:
        "Translation relay authentication failed. Please contact support if this persists.",
      statusCode: 503,
    };
  }

  return {
    message:
      "Translation relay submission endpoint is unavailable. Please retry shortly.",
    statusCode: 503,
  };
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

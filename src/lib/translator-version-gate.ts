import type { Context, Next } from "hono";
import type { Stage5ApiBindings } from "../types/env";

export const TRANSLATOR_VERSION_HEADER = "X-Stage5-App-Version";
const DEFAULT_DOWNLOAD_URL = "https://stage5.tools";
const UPDATE_REQUIRED_ERROR = "update-required";
const DEFAULT_UPDATE_REQUIRED_MESSAGE =
  "A newer version of Translator is required to continue. Please update the app.";

type EnforcementMode = "off" | "log" | "enforce";

export type TranslatorVersionGatePayload = {
  error: typeof UPDATE_REQUIRED_ERROR;
  message: string;
  minVersion: string;
  clientVersion?: string;
  downloadUrl: string;
  source: "stage5-api";
};

export type TranslatorVersionGateEvaluation = {
  mode: EnforcementMode;
  payload: TranslatorVersionGatePayload | null;
};

function normalizeVersion(raw: string | undefined | null): string {
  return String(raw || "").trim().replace(/^v/i, "");
}

function parseVersionParts(raw: string | undefined | null): number[] | null {
  const normalized = normalizeVersion(raw);
  if (!normalized) return null;
  const match = normalized.match(/^\d+(?:\.\d+){0,3}/);
  if (!match) return null;
  return match[0].split(".").map((part) => Number.parseInt(part, 10));
}

function compareVersionParts(a: number[], b: number[]): number {
  const maxLength = Math.max(a.length, b.length);
  for (let i = 0; i < maxLength; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

function resolveEnforcementMode(raw: string | undefined): EnforcementMode {
  const normalized = String(raw || "")
    .trim()
    .toLowerCase();
  if (normalized === "log") return "log";
  if (normalized === "enforce") return "enforce";
  return "off";
}

function buildPayload(params: {
  minVersion: string;
  clientVersion?: string;
  downloadUrl: string;
}): TranslatorVersionGatePayload {
  return {
    error: UPDATE_REQUIRED_ERROR,
    message: DEFAULT_UPDATE_REQUIRED_MESSAGE,
    minVersion: params.minVersion,
    clientVersion: params.clientVersion,
    downloadUrl: params.downloadUrl,
    source: "stage5-api",
  };
}

export function evaluateTranslatorVersion(params: {
  minVersionRaw?: string;
  enforcementRaw?: string;
  downloadUrlRaw?: string;
  clientVersionRaw?: string | null;
}): TranslatorVersionGateEvaluation {
  const minVersion = normalizeVersion(params.minVersionRaw);
  const mode = resolveEnforcementMode(params.enforcementRaw);
  if (!minVersion || mode === "off") {
    return { mode, payload: null };
  }

  const minParts = parseVersionParts(minVersion);
  if (!minParts) {
    console.error(
      `[translator-version-gate] Invalid MIN_TRANSLATOR_VERSION: ${params.minVersionRaw}`
    );
    return { mode: "off", payload: null };
  }

  const clientVersion = normalizeVersion(params.clientVersionRaw);
  const clientParts = parseVersionParts(clientVersion);
  if (clientParts && compareVersionParts(clientParts, minParts) >= 0) {
    return { mode, payload: null };
  }

  return {
    mode,
    payload: buildPayload({
      minVersion,
      clientVersion: clientVersion || undefined,
      downloadUrl: String(params.downloadUrlRaw || DEFAULT_DOWNLOAD_URL),
    }),
  };
}

function evaluateRequestVersion(
  c: Context<{ Bindings: Stage5ApiBindings }>
): TranslatorVersionGateEvaluation {
  return evaluateTranslatorVersion({
    minVersionRaw: c.env.MIN_TRANSLATOR_VERSION,
    enforcementRaw: c.env.MIN_TRANSLATOR_VERSION_ENFORCEMENT,
    downloadUrlRaw: c.env.TRANSLATOR_DOWNLOAD_URL,
    clientVersionRaw: c.req.header(TRANSLATOR_VERSION_HEADER),
  });
}

export function minimumTranslatorVersionGate() {
  return async (c: Context<{ Bindings: Stage5ApiBindings }>, next: Next) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname.startsWith("/transcribe/webhook/")) {
      await next();
      return;
    }

    const result = evaluateRequestVersion(c);
    if (!result.payload) {
      await next();
      return;
    }

    console.warn(
      `[translator-version-gate] ${result.mode} path=${pathname} client=${result.payload.clientVersion || "missing"} min=${result.payload.minVersion}`
    );

    if (result.mode === "enforce") {
      return c.json(result.payload, 426);
    }

    await next();
  };
}

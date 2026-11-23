// Job details the desktop app (Translator 1.34.0+) sends with credit-based
// transcription and translation requests. They are stored with the job's
// credit hold and its ledger row, and nowhere else. Only these four fields
// are ever kept: no titles, URLs, file names, audio, subtitle text or
// prompts. A site is one of the well-known names in KNOWN_VIDEO_SITES or
// "other"; any other host name is recorded as "other", never as itself.
//
// Every field is optional and validated on its own: a bad value drops that
// field, never the request.

import {
  KNOWN_VIDEO_SITES,
  OTHER_VIDEO_SITE,
} from "../shared/known-video-sites";

export type JobDetails = {
  sourceLanguage?: string;
  targetLanguage?: string;
  videoSeconds?: number;
  sourceSite?: string;
};

const MAX_RAW_LENGTH = 512;
const MAX_VIDEO_SECONDS = 7 * 24 * 60 * 60;
// An ISO-style code ("en", "eng", "pt-br") or one of the app's language
// tokens ("korean", "chinese_simplified").
const LANGUAGE_PATTERN =
  /^(?:[a-z]{2,3}(?:-[a-z0-9]{2,8})?|[a-z]{3,12}(?:_[a-z]{3,12}){0,2})$/;
const KNOWN_SITES: ReadonlySet<string> = new Set(KNOWN_VIDEO_SITES);
// Shape of a host name. Anything of this shape that is not a known site is
// kept only as "other".
const HOST_PATTERN =
  /^(?=.{4,100}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

function language(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return LANGUAGE_PATTERN.test(normalized) ? normalized : undefined;
}

function videoSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return rounded >= 1 && rounded <= MAX_VIDEO_SECONDS ? rounded : undefined;
}

function sourceSite(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (KNOWN_SITES.has(normalized)) return normalized;
  return normalized === OTHER_VIDEO_SITE || HOST_PATTERN.test(normalized)
    ? OTHER_VIDEO_SITE
    : undefined;
}

/**
 * Accepts the raw header value (JSON text) or an already-parsed object.
 * Returns null when nothing valid is left.
 */
export function parseJobDetails(raw: unknown): JobDetails | null {
  let candidate: unknown = raw;
  if (typeof raw === "string") {
    if (!raw || raw.length > MAX_RAW_LENGTH) return null;
    try {
      candidate = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const record = candidate as Record<string, unknown>;
  const details: JobDetails = {};
  const source = language(record.sourceLanguage);
  if (source) details.sourceLanguage = source;
  const target = language(record.targetLanguage);
  if (target) details.targetLanguage = target;
  const seconds = videoSeconds(record.videoSeconds);
  if (seconds) details.videoSeconds = seconds;
  const site = sourceSite(record.sourceSite);
  if (site) details.sourceSite = site;
  return Object.keys(details).length > 0 ? details : null;
}

/** Spread into a credit record's meta: `{ ...jobMeta(details) }`. */
export function jobMeta(details: JobDetails | null): { job?: JobDetails } {
  return details ? { job: details } : {};
}

/** Meta without a `job` key, for records that must not carry job details. */
export function withoutJobKey(meta: unknown): unknown {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return meta;
  if (!("job" in meta)) return meta;
  const { job: _dropped, ...rest } = meta as Record<string, unknown>;
  return rest;
}

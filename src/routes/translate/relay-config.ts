import type { RelayTranslationBindings } from "../../types/env";

export function getRelayDispatchConfig(env: RelayTranslationBindings): {
  maxInFlight: number;
  batchSize: number;
} {
  const maxInFlight = parsePositiveInt(env.RELAY_TRANSLATION_MAX_INFLIGHT, 40, {
    min: 1,
    max: 2000,
  });
  const batchSize = parsePositiveInt(env.RELAY_TRANSLATION_DISPATCH_BATCH, 8, {
    min: 1,
    max: 200,
  });
  return { maxInFlight, batchSize };
}

export function getRelayAdmissionConfig(env: RelayTranslationBindings): {
  userMaxActiveJobs: number;
  globalMaxPendingJobs: number;
  userRateWindowSec: number;
  userRateMaxRequests: number;
} {
  const userMaxActiveJobs = parsePositiveInt(
    env.RELAY_TRANSLATION_USER_MAX_ACTIVE,
    3,
    { min: 1, max: 100 }
  );
  const globalMaxPendingJobs = parsePositiveInt(
    env.RELAY_TRANSLATION_GLOBAL_MAX_PENDING,
    1200,
    { min: 10, max: 100_000 }
  );
  const userRateWindowSec = parsePositiveInt(
    env.RELAY_TRANSLATION_USER_RATE_WINDOW_SEC,
    60,
    { min: 1, max: 3600 }
  );
  const userRateMaxRequests = parsePositiveInt(
    env.RELAY_TRANSLATION_USER_RATE_MAX_REQUESTS,
    20,
    { min: 1, max: 5000 }
  );
  return {
    userMaxActiveJobs,
    globalMaxPendingJobs,
    userRateWindowSec,
    userRateMaxRequests,
  };
}

export function getRelayAlertConfig(env: RelayTranslationBindings): {
  queueDepthThreshold: number;
  cooldownMs: number;
  consecutiveFailuresThreshold: number;
} {
  const queueDepthThreshold = parsePositiveInt(
    env.RELAY_TRANSLATION_ALERT_QUEUE_DEPTH,
    100,
    { min: 1, max: 100_000 }
  );
  const cooldownMs = parsePositiveInt(
    env.RELAY_TRANSLATION_ALERT_COOLDOWN_MS,
    60_000,
    { min: 1_000, max: 86_400_000 }
  );
  const consecutiveFailuresThreshold = parsePositiveInt(
    env.RELAY_TRANSLATION_ALERT_CONSECUTIVE_FAILURES,
    5,
    { min: 1, max: 500 }
  );
  return { queueDepthThreshold, cooldownMs, consecutiveFailuresThreshold };
}

function parsePositiveInt(
  rawValue: string | undefined,
  fallback: number,
  { min = 1, max = 500 }: { min?: number; max?: number } = {}
): number {
  if (!rawValue) return fallback;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

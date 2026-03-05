type LabelValue = string | number | boolean | null | undefined;
type Labels = Record<string, LabelValue>;

type DurationStats = {
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
};

const counters = new Map<string, number>();
const durations = new Map<string, DurationStats>();
const alertCooldowns = new Map<string, number>();

const STARTED_AT_MS = Date.now();

function toLabelKey(labels?: Labels): string {
  if (!labels) return "";
  const parts = Object.entries(labels)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`);
  return parts.join(",");
}

function toMetricKey(name: string, labels?: Labels): string {
  const labelKey = toLabelKey(labels);
  return labelKey ? `${name}|${labelKey}` : name;
}

export function incrementCounter(name: string, labels?: Labels, by = 1): void {
  if (!Number.isFinite(by) || by === 0) return;
  const key = toMetricKey(name, labels);
  counters.set(key, (counters.get(key) ?? 0) + by);
}

export function observeDuration(
  name: string,
  durationMs: number,
  labels?: Labels
): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  const key = toMetricKey(name, labels);
  const prev = durations.get(key) ?? {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    lastMs: 0,
  };
  const next: DurationStats = {
    count: prev.count + 1,
    totalMs: prev.totalMs + durationMs,
    maxMs: Math.max(prev.maxMs, durationMs),
    lastMs: durationMs,
  };
  durations.set(key, next);
}

export function emitAlert(
  alertKey: string,
  message: string,
  {
    cooldownMs = 60_000,
    context,
  }: {
    cooldownMs?: number;
    context?: Record<string, unknown>;
  } = {}
): boolean {
  const now = Date.now();
  const last = alertCooldowns.get(alertKey) ?? 0;
  if (now - last < cooldownMs) return false;

  alertCooldowns.set(alertKey, now);
  incrementCounter("alert.emitted_total", { alertKey });
  console.error(
    `[ALERT][${alertKey}] ${message}`,
    context ? JSON.stringify(context) : ""
  );
  return true;
}

export function getObservabilitySnapshot(): {
  generatedAt: string;
  uptimeSec: number;
  counters: Array<{ metric: string; value: number }>;
  durations: Array<{ metric: string; stats: DurationStats & { avgMs: number } }>;
} {
  return {
    generatedAt: new Date().toISOString(),
    uptimeSec: Math.floor((Date.now() - STARTED_AT_MS) / 1000),
    counters: Array.from(counters.entries())
      .map(([metric, value]) => ({ metric, value }))
      .sort((a, b) => a.metric.localeCompare(b.metric)),
    durations: Array.from(durations.entries())
      .map(([metric, stats]) => ({
        metric,
        stats: {
          ...stats,
          avgMs: stats.count > 0 ? stats.totalMs / stats.count : 0,
        },
      }))
      .sort((a, b) => a.metric.localeCompare(b.metric)),
  };
}

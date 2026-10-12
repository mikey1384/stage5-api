import { executeAtomicBatch, getDatabase } from "./db/core";
import { deriveAnonymousClientId } from "./product-analytics";
import type { Stage5ApiBindings } from "../types/env";

export type AnalyticsPreference = { enabled: boolean; revision: number };

export async function readAnalyticsPreference(
  env: Stage5ApiBindings, subjectKey: string,
): Promise<AnalyticsPreference | null> {
  const clientId = await deriveAnonymousClientId(env, subjectKey);
  if (!clientId) return null;
  const row = await getDatabase().prepare(
    "SELECT enabled, revision FROM analytics_preferences WHERE client_id = ?",
  ).bind(clientId).first();
  return { enabled: row?.enabled === 1, revision: Number(row?.revision ?? 0) };
}

export async function saveAnalyticsPreference(
  env: Stage5ApiBindings, subjectKey: string, choice: AnalyticsPreference,
): Promise<AnalyticsPreference | null> {
  const clientId = await deriveAnonymousClientId(env, subjectKey);
  if (!clientId) return null;
  if (!Number.isSafeInteger(choice.revision) || choice.revision < 0 ||
      typeof choice.enabled !== "boolean") throw new Error("Invalid analytics preference");
  const db = getDatabase();
  // Monotonic revisions make timed-out retries safe: an old opt-in cannot
  // replace a newer withdrawal. Clear queued details in the same transaction.
  await executeAtomicBatch([
    db.prepare(`INSERT INTO analytics_preferences (client_id, enabled, revision)
      VALUES (?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET
      enabled = excluded.enabled, revision = excluded.revision,
      updated_at = CURRENT_TIMESTAMP
      WHERE excluded.revision > analytics_preferences.revision`)
      .bind(clientId, Number(choice.enabled), choice.revision),
    db.prepare(`UPDATE analytics_outbox SET discarded_at = CURRENT_TIMESTAMP, available_at = '9999-12-31T23:59:59.999Z',
      discard_reason = 'consent_withdrawn', client_id = '', params_json = '{}',
      last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE client_id = ? AND sent_at IS NULL AND discarded_at IS NULL
      AND EXISTS (SELECT 1 FROM analytics_preferences WHERE client_id = ? AND enabled = 0)`)
      .bind(clientId, clientId),
  ]);
  return readAnalyticsPreference(env, subjectKey);
}

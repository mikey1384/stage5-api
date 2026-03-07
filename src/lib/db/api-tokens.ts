import crypto from "node:crypto";
import { getDatabase } from "./core";
import type { CreditRecord } from "./credits";

const API_TOKEN_PREFIX = "s5_";
const API_TOKEN_BYTES = 32;
const RECOVERY_TOKEN_PREFIX = "s5r_";
const RECOVERY_TOKEN_BYTES = 32;
const DEVICE_API_ISSUE_KINDS = ["legacy", "recovery"] as const;

export type DeviceApiIssueKind = (typeof DEVICE_API_ISSUE_KINDS)[number];

export interface DeviceApiTokenRecord {
  device_id: string;
  token_hash: string;
  recovery_token_hash: string | null;
  legacy_bootstrap_allowed: number;
  pending_issue_kind: DeviceApiIssueKind | null;
  pending_issue_nonce: string | null;
  pending_recovery_binding_hash: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_used_at: string | null;
}

interface DeviceApiTokenCasSnapshot {
  legacyBootstrapAllowed: number;
  tokenHash: string;
  recoveryTokenHash: string;
  pendingIssueKind: string;
  pendingIssueNonce: string;
  pendingRecoveryBindingHash: string;
}

function normalizeNullableState(value: string | null | undefined): string {
  return value ?? "";
}

function didStatementChange(result: { meta?: { changes?: number } } | null | undefined): boolean {
  return (result?.meta?.changes ?? 0) > 0;
}

export function isLikelyLegacyDeviceId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value.trim()
  );
}

function hashApiToken(apiToken: string): string {
  return crypto.createHash("sha256").update(apiToken).digest("hex");
}

function generateApiToken(): string {
  return `${API_TOKEN_PREFIX}${crypto.randomBytes(API_TOKEN_BYTES).toString("base64url")}`;
}

function generateRecoveryToken(): string {
  return `${RECOVERY_TOKEN_PREFIX}${crypto.randomBytes(RECOVERY_TOKEN_BYTES).toString("base64url")}`;
}

function generateIssueNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

function buildDerivedToken({
  prefix,
  deviceId,
  issueKind,
  issueNonce,
  slot,
  secret,
}: {
  prefix: string;
  deviceId: string;
  issueKind: DeviceApiIssueKind;
  issueNonce: string;
  slot: "api" | "recovery";
  secret: string;
}): string {
  const body = crypto
    .createHmac("sha256", secret)
    .update(`${deviceId}:${issueKind}:${issueNonce}:${slot}`)
    .digest("base64url");
  return `${prefix}${body}`;
}

export function deriveDeviceApiCredentials({
  deviceId,
  issueKind,
  issueNonce,
  secret,
}: {
  deviceId: string;
  issueKind: DeviceApiIssueKind;
  issueNonce: string;
  secret: string;
}): { apiToken: string; recoveryToken: string } {
  return {
    apiToken: buildDerivedToken({
      prefix: API_TOKEN_PREFIX,
      deviceId,
      issueKind,
      issueNonce,
      slot: "api",
      secret,
    }),
    recoveryToken: buildDerivedToken({
      prefix: RECOVERY_TOKEN_PREFIX,
      deviceId,
      issueKind,
      issueNonce,
      slot: "recovery",
      secret,
    }),
  };
}

// Device-token provisioning is intentionally replayable:
// 1. Persist a pending issue marker (kind + nonce [+ recovery binding hash]).
// 2. Re-derive the same credential pair from a stable device-token secret.
// 3. If the response is lost, a retry replays the same pair even if
//    RELAY_SECRET rotated after the original issuance.
function replayPendingLegacyBootstrapCredentials({
  record,
  deviceId,
  secret,
}: {
  record: DeviceApiTokenRecord | null;
  deviceId: string;
  secret: string;
}): { apiToken: string; recoveryToken: string } | null {
  if (record?.pending_issue_kind !== "legacy" || !record.pending_issue_nonce) {
    return null;
  }
  return deriveDeviceApiCredentials({
    deviceId,
    issueKind: "legacy",
    issueNonce: record.pending_issue_nonce,
    secret,
  });
}

function replayPendingRecoveryCredentials({
  record,
  deviceId,
  recoveryHash,
  secret,
}: {
  record: DeviceApiTokenRecord | null;
  deviceId: string;
  recoveryHash: string;
  secret: string;
}): { apiToken: string; recoveryToken: string } | null {
  if (
    record?.pending_issue_kind !== "recovery" ||
    !record.pending_issue_nonce ||
    record.pending_recovery_binding_hash !== recoveryHash
  ) {
    return null;
  }
  return deriveDeviceApiCredentials({
    deviceId,
    issueKind: "recovery",
    issueNonce: record.pending_issue_nonce,
    secret,
  });
}

function captureDeviceApiTokenCasSnapshot(
  record: DeviceApiTokenRecord
): DeviceApiTokenCasSnapshot {
  return {
    legacyBootstrapAllowed: record.legacy_bootstrap_allowed,
    tokenHash: record.token_hash,
    recoveryTokenHash: normalizeNullableState(record.recovery_token_hash),
    pendingIssueKind: normalizeNullableState(record.pending_issue_kind),
    pendingIssueNonce: normalizeNullableState(record.pending_issue_nonce),
    pendingRecoveryBindingHash: normalizeNullableState(
      record.pending_recovery_binding_hash
    ),
  };
}

async function tryInsertPendingLegacyBootstrapIssue({
  deviceId,
  tokenHash,
  recoveryTokenHash,
  issueNonce,
}: {
  deviceId: string;
  tokenHash: string;
  recoveryTokenHash: string;
  issueNonce: string;
}): Promise<boolean> {
  const db = getDatabase();
  const insertResult = await db
    .prepare(
      `INSERT INTO device_api_tokens (
          device_id,
          token_hash,
          recovery_token_hash,
          legacy_bootstrap_allowed,
          pending_issue_kind,
          pending_issue_nonce,
          pending_recovery_binding_hash,
          created_at,
          updated_at,
          last_used_at
        )
        VALUES (?, ?, ?, 1, 'legacy', ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(device_id) DO NOTHING`
    )
    .bind(
      deviceId,
      tokenHash,
      recoveryTokenHash,
      issueNonce
    )
    .run();
  return didStatementChange(insertResult);
}

async function tryCompareAndSwapPendingIssue({
  deviceId,
  issueKind,
  issueNonce,
  nextApiTokenHash,
  nextRecoveryTokenHash,
  pendingRecoveryBindingHash,
  expected,
}: {
  deviceId: string;
  issueKind: DeviceApiIssueKind;
  issueNonce: string;
  nextApiTokenHash: string;
  nextRecoveryTokenHash: string;
  pendingRecoveryBindingHash: string | null;
  expected: DeviceApiTokenCasSnapshot;
}): Promise<boolean> {
  const db = getDatabase();
  const updateResult = await db
    .prepare(
      `UPDATE device_api_tokens
          SET token_hash = ?,
              recovery_token_hash = ?,
              ${issueKind === "legacy" ? "legacy_bootstrap_allowed = 1," : ""}
              pending_issue_kind = ?,
              pending_issue_nonce = ?,
              pending_recovery_binding_hash = ?,
              updated_at = CURRENT_TIMESTAMP,
              last_used_at = CURRENT_TIMESTAMP
        WHERE device_id = ?
          AND legacy_bootstrap_allowed = ?
          AND token_hash = ?
          AND COALESCE(recovery_token_hash, '') = ?
          AND COALESCE(pending_issue_kind, '') = ?
          AND COALESCE(pending_issue_nonce, '') = ?
          AND COALESCE(pending_recovery_binding_hash, '') = ?`
    )
    .bind(
      nextApiTokenHash,
      nextRecoveryTokenHash,
      issueKind,
      issueNonce,
      normalizeNullableState(pendingRecoveryBindingHash),
      deviceId,
      expected.legacyBootstrapAllowed,
      expected.tokenHash,
      expected.recoveryTokenHash,
      expected.pendingIssueKind,
      expected.pendingIssueNonce,
      expected.pendingRecoveryBindingHash
    )
    .run();
  return didStatementChange(updateResult);
}

export async function getDeviceApiTokenRecord({
  deviceId,
}: {
  deviceId: string;
}): Promise<DeviceApiTokenRecord | null> {
  const db = getDatabase();
  const stmt = db.prepare(
    `SELECT
        device_id,
        token_hash,
        recovery_token_hash,
        legacy_bootstrap_allowed,
        pending_issue_kind,
        pending_issue_nonce,
        pending_recovery_binding_hash,
        created_at,
        updated_at,
        last_used_at
       FROM device_api_tokens
      WHERE device_id = ?`
  );
  const row = await stmt.bind(deviceId).first();
  return (row as DeviceApiTokenRecord) ?? null;
}

export async function getDeviceApiTokenRecordByRecoveryToken({
  recoveryToken,
}: {
  recoveryToken: string;
}): Promise<DeviceApiTokenRecord | null> {
  const db = getDatabase();
  const recoveryHash = hashApiToken(recoveryToken.trim());
  const stmt = db.prepare(
    `SELECT
        device_id,
        token_hash,
        recovery_token_hash,
        legacy_bootstrap_allowed,
        pending_issue_kind,
        pending_issue_nonce,
        pending_recovery_binding_hash,
        created_at,
        updated_at,
        last_used_at
       FROM device_api_tokens
      WHERE recovery_token_hash = ?
         OR pending_recovery_binding_hash = ?
      LIMIT 1`
  );
  const row = await stmt.bind(recoveryHash, recoveryHash).first();
  return (row as DeviceApiTokenRecord) ?? null;
}

export async function hasPersistedStage5DeviceState({
  deviceId,
}: {
  deviceId: string;
}): Promise<boolean> {
  const db = getDatabase();
  const stmt = db.prepare(
    `SELECT CASE
        WHEN EXISTS(SELECT 1 FROM credits WHERE device_id = ?)
          OR EXISTS(SELECT 1 FROM entitlements WHERE device_id = ?)
          OR EXISTS(SELECT 1 FROM credit_ledger WHERE device_id = ?)
          OR EXISTS(SELECT 1 FROM stripe_fulfillments WHERE device_id = ?)
        THEN 1
        ELSE 0
      END AS has_state`
  );
  const row = (await stmt
    .bind(deviceId, deviceId, deviceId, deviceId)
    .first()) as { has_state?: number | string | boolean } | null;
  return Number(row?.has_state ?? 0) > 0;
}

export async function registerDeviceApiCredentials({
  deviceId,
}: {
  deviceId: string;
}): Promise<{ apiToken: string; recoveryToken: string }> {
  const db = getDatabase();

  const apiToken = generateApiToken();
  const tokenHash = hashApiToken(apiToken);
  const recoveryToken = generateRecoveryToken();
  const recoveryTokenHash = hashApiToken(recoveryToken);
  const stmt = db.prepare(`
    INSERT INTO device_api_tokens (
      device_id,
      token_hash,
      recovery_token_hash,
      legacy_bootstrap_allowed,
      pending_issue_kind,
      pending_issue_nonce,
      pending_recovery_binding_hash,
      created_at,
      updated_at,
      last_used_at
    )
    VALUES (?, ?, ?, 1, NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(device_id) DO UPDATE SET
      token_hash = excluded.token_hash,
      recovery_token_hash = excluded.recovery_token_hash,
      legacy_bootstrap_allowed = 1,
      pending_issue_kind = NULL,
      pending_issue_nonce = NULL,
      pending_recovery_binding_hash = NULL,
      updated_at = CURRENT_TIMESTAMP,
      last_used_at = CURRENT_TIMESTAMP
  `);

  await stmt.bind(deviceId, tokenHash, recoveryTokenHash).run();
  return { apiToken, recoveryToken };
}

export async function registerDeviceApiToken({
  deviceId,
}: {
  deviceId: string;
}): Promise<string> {
  const { apiToken } = await registerDeviceApiCredentials({ deviceId });
  return apiToken;
}

export async function rotateDeviceApiToken({
  deviceId,
}: {
  deviceId: string;
}): Promise<string> {
  const db = getDatabase();
  const apiToken = generateApiToken();
  const tokenHash = hashApiToken(apiToken);
  await db
    .prepare(
      `UPDATE device_api_tokens
          SET token_hash = ?,
              legacy_bootstrap_allowed = CASE
                WHEN recovery_token_hash IS NOT NULL THEN 0
                ELSE legacy_bootstrap_allowed
              END,
              pending_issue_kind = NULL,
              pending_issue_nonce = NULL,
              pending_recovery_binding_hash = NULL,
              updated_at = CURRENT_TIMESTAMP,
              last_used_at = CURRENT_TIMESTAMP
        WHERE device_id = ?`
    )
    .bind(tokenHash, deviceId)
    .run();
  return apiToken;
}

export async function rotateDeviceApiCredentials({
  deviceId,
}: {
  deviceId: string;
}): Promise<{ apiToken: string; recoveryToken: string }> {
  const db = getDatabase();
  const apiToken = generateApiToken();
  const recoveryToken = generateRecoveryToken();
  await db
    .prepare(
      `UPDATE device_api_tokens
          SET token_hash = ?,
              recovery_token_hash = ?,
              legacy_bootstrap_allowed = 0,
              pending_issue_kind = NULL,
              pending_issue_nonce = NULL,
              pending_recovery_binding_hash = NULL,
              updated_at = CURRENT_TIMESTAMP,
              last_used_at = CURRENT_TIMESTAMP
        WHERE device_id = ?`
    )
    .bind(
      hashApiToken(apiToken),
      hashApiToken(recoveryToken),
      deviceId
    )
    .run();
  return { apiToken, recoveryToken };
}

export async function rotateDeviceRecoveryToken({
  deviceId,
}: {
  deviceId: string;
}): Promise<string> {
  const db = getDatabase();
  const recoveryToken = generateRecoveryToken();
  const recoveryTokenHash = hashApiToken(recoveryToken);
  await db
    .prepare(
      `UPDATE device_api_tokens
          SET recovery_token_hash = ?,
              pending_issue_kind = NULL,
              pending_issue_nonce = NULL,
              pending_recovery_binding_hash = NULL,
              updated_at = CURRENT_TIMESTAMP,
              last_used_at = CURRENT_TIMESTAMP
        WHERE device_id = ?`
    )
    .bind(recoveryTokenHash, deviceId)
    .run();
  return recoveryToken;
}

export async function getUserByOpaqueApiToken({
  apiToken,
}: {
  apiToken: string;
}): Promise<CreditRecord | null> {
  const db = getDatabase();
  const tokenHash = hashApiToken(apiToken.trim());
  const stmt = db.prepare(`
    SELECT
      COALESCE(c.device_id, t.device_id) AS device_id,
      COALESCE(c.credit_balance, 0) AS credit_balance,
      c.updated_at AS updated_at,
      t.recovery_token_hash AS recovery_token_hash
      FROM device_api_tokens t
      LEFT JOIN credits c
        ON c.device_id = t.device_id
     WHERE t.token_hash = ?
     LIMIT 1
  `);
  const row = (await stmt.bind(tokenHash).first()) as
    | (CreditRecord & { recovery_token_hash: string | null })
    | null;
  if (!row) {
    return null;
  }

  await db
    .prepare(
      `UPDATE device_api_tokens
          SET last_used_at = CURRENT_TIMESTAMP,
              legacy_bootstrap_allowed = CASE
                WHEN recovery_token_hash IS NOT NULL THEN 0
                ELSE legacy_bootstrap_allowed
              END,
              pending_issue_kind = NULL,
              pending_issue_nonce = NULL,
              pending_recovery_binding_hash = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE token_hash = ?`
    )
    .bind(tokenHash)
    .run();

  return row;
}

export async function beginOrReplayLegacyBootstrapIssue({
  deviceId,
  secret,
}: {
  deviceId: string;
  secret: string;
}): Promise<{
  apiToken: string;
  recoveryToken: string;
  replayed: boolean;
  existing: boolean;
} | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await getDeviceApiTokenRecord({ deviceId });

    if (existing && !existing.legacy_bootstrap_allowed) {
      return null;
    }

    const replay = replayPendingLegacyBootstrapCredentials({
      record: existing,
      deviceId,
      secret,
    });
    if (replay) {
      return {
        ...replay,
        replayed: true,
        existing: !!existing,
      };
    }

    const issueNonce = generateIssueNonce();
    const { apiToken, recoveryToken } = deriveDeviceApiCredentials({
      deviceId,
      issueKind: "legacy",
      issueNonce,
      secret,
    });

    if (!existing) {
      if (
        await tryInsertPendingLegacyBootstrapIssue({
          deviceId,
          tokenHash: hashApiToken(apiToken),
          recoveryTokenHash: hashApiToken(recoveryToken),
          issueNonce,
        })
      ) {
        return { apiToken, recoveryToken, replayed: false, existing: false };
      }

      continue;
    }

    if (
      await tryCompareAndSwapPendingIssue({
        deviceId,
        issueKind: "legacy",
        issueNonce,
        nextApiTokenHash: hashApiToken(apiToken),
        nextRecoveryTokenHash: hashApiToken(recoveryToken),
        pendingRecoveryBindingHash: null,
        expected: captureDeviceApiTokenCasSnapshot(existing),
      })
    ) {
      return { apiToken, recoveryToken, replayed: false, existing: true };
    }
  }

  const current = await getDeviceApiTokenRecord({ deviceId });
  if (current && !current.legacy_bootstrap_allowed) {
    return null;
  }
  const replay = replayPendingLegacyBootstrapCredentials({
    record: current,
    deviceId,
    secret,
  });
  if (replay) {
    return {
      ...replay,
      replayed: true,
      existing: !!current,
    };
  }

  throw new Error("Failed to provision device token");
}

export async function beginOrReplayRecoveryIssue({
  deviceId,
  recoveryToken,
  secret,
}: {
  deviceId: string;
  recoveryToken: string;
  secret: string;
}): Promise<{
  apiToken: string;
  recoveryToken: string;
  replayed: boolean;
} | null> {
  const recoveryHash = hashApiToken(recoveryToken.trim());

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record = await getDeviceApiTokenRecordByRecoveryToken({ recoveryToken });
    if (!record || record.device_id !== deviceId) {
      return null;
    }

    const replay = replayPendingRecoveryCredentials({
      record,
      deviceId,
      recoveryHash,
      secret,
    });
    if (replay) {
      return {
        ...replay,
        replayed: true,
      };
    }

    if (record.recovery_token_hash !== recoveryHash) {
      return null;
    }

    const issueNonce = generateIssueNonce();
    const nextCredentials = deriveDeviceApiCredentials({
      deviceId,
      issueKind: "recovery",
      issueNonce,
      secret,
    });

    if (
      await tryCompareAndSwapPendingIssue({
        deviceId,
        issueKind: "recovery",
        issueNonce,
        nextApiTokenHash: hashApiToken(nextCredentials.apiToken),
        nextRecoveryTokenHash: hashApiToken(nextCredentials.recoveryToken),
        pendingRecoveryBindingHash: recoveryHash,
        expected: captureDeviceApiTokenCasSnapshot(record),
      })
    ) {
      return { ...nextCredentials, replayed: false };
    }
  }

  const current = await getDeviceApiTokenRecordByRecoveryToken({ recoveryToken });
  if (!current || current.device_id !== deviceId) {
    return null;
  }
  const replay = replayPendingRecoveryCredentials({
    record: current,
    deviceId,
    recoveryHash,
    secret,
  });
  if (replay) {
    return {
      ...replay,
      replayed: true,
    };
  }
  if (current.recovery_token_hash !== recoveryHash) {
    return null;
  }

  throw new Error("Failed to rotate recovery credentials");
}

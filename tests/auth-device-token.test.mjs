import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";

import worker from "../src/index.ts";
import { ensureDatabase } from "../src/lib/db/core.ts";
import {
  creditDevice,
  registerDeviceApiToken,
  registerDeviceApiCredentials,
} from "../src/lib/db.ts";
import {
  createSqliteD1Database,
  resetSqliteD1Database,
} from "./helpers/sqlite-d1.mjs";

const { sqlite, db } = createSqliteD1Database();

const env = {
  DB: db,
  ALLOWED_ORIGINS: "https://translator.tools",
  UI_ORIGIN: "https://translator.tools",
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_dummy",
  STRIPE_BYO_UNLOCK_PRICE_ID: "price_byo_unlock",
  RELAY_SECRET: "relay-secret",
  OPENAI_API_KEY: "openai-test-key",
  RECONCILE_CRON_ENABLED: "0",
  RECONCILE_CRON_DRY_RUN: "0",
};

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
};

async function apiRequest(path, init = {}, envOverride = {}) {
  const request = new Request(`http://localhost${path}`, init);
  return worker.fetch(request, { ...env, ...envOverride }, ctx);
}

before(async () => {
  resetSqliteD1Database(sqlite);
  await ensureDatabase({ DB: db });
});

beforeEach(() => {
  resetSqliteD1Database(sqlite);
});

test("legacy bootstrap is still allowed for a brand-new empty device", async () => {
  const deviceId = "10000000-0000-4000-8000-000000000001";
  const response = await apiRequest("/auth/device-token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deviceId}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "provisioned");
  assert.match(body.apiToken, /^s5_/);
  assert.match(body.recoveryToken, /^s5r_/);
});

test("legacy bootstrap is allowed for previously active UUID-authenticated devices", async () => {
  const deviceId = "10000000-0000-4000-8000-000000000002";
  await creditDevice({ deviceId, packId: "MICRO" });

  const response = await apiRequest("/auth/device-token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deviceId}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "provisioned");
  assert.match(body.apiToken, /^s5_/);
  assert.match(body.recoveryToken, /^s5r_/);
});

test("opaque-token verification does not mint new recovery access", async () => {
  const deviceId = "10000000-0000-4000-8000-000000000003";
  const { apiToken, recoveryToken } = await registerDeviceApiCredentials({
    deviceId,
  });

  const verifyResponse = await apiRequest("/auth/device-token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId }),
  });

  assert.equal(verifyResponse.status, 200);
  const verifyBody = await verifyResponse.json();
  assert.equal(verifyBody.mode, "verified");
  assert.equal(verifyBody.apiToken, apiToken);
  assert.equal("recoveryToken" in verifyBody, false);

  const recoverResponse = await apiRequest("/auth/device-token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${recoveryToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId }),
  });

  assert.equal(recoverResponse.status, 200);
  const recoverBody = await recoverResponse.json();
  assert.equal(recoverBody.mode, "recovered");
  assert.notEqual(recoverBody.apiToken, apiToken);
  assert.match(recoverBody.recoveryToken, /^s5r_/);
  assert.notEqual(recoverBody.recoveryToken, recoveryToken);
});

test("legacy bootstrap replays the same credentials after a lost response", async () => {
  const deviceId = "10000000-0000-4000-8000-000000000004";
  await creditDevice({ deviceId, packId: "MICRO" });

  const first = await apiRequest("/auth/device-token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deviceId}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId }),
  });
  const firstBody = await first.json();

  const retry = await apiRequest("/auth/device-token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deviceId}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId }),
  });
  const retryBody = await retry.json();

  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(retryBody.mode, "provisioning-replayed");
  assert.equal(retryBody.apiToken, firstBody.apiToken);
  assert.equal(retryBody.recoveryToken, firstBody.recoveryToken);
});

test("legacy bootstrap replay survives RELAY_SECRET rotation", async () => {
  const deviceId = "10000000-0000-4000-8000-000000000007";

  const first = await apiRequest(
    "/auth/device-token",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deviceId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    },
    { RELAY_SECRET: "relay-secret-a" },
  );
  const firstBody = await first.json();

  const retry = await apiRequest(
    "/auth/device-token",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deviceId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    },
    { RELAY_SECRET: "relay-secret-b" },
  );
  const retryBody = await retry.json();

  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(retryBody.mode, "provisioning-replayed");
  assert.equal(retryBody.apiToken, firstBody.apiToken);
  assert.equal(retryBody.recoveryToken, firstBody.recoveryToken);
});

test("legacy bootstrap replay survives STRIPE_WEBHOOK_SECRET rotation", async () => {
  const deviceId = "10000000-0000-4000-8000-000000000011";

  const first = await apiRequest(
    "/auth/device-token",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deviceId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    },
    { STRIPE_WEBHOOK_SECRET: "whsec_a" },
  );
  const firstBody = await first.json();

  const retry = await apiRequest(
    "/auth/device-token",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deviceId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    },
    { STRIPE_WEBHOOK_SECRET: "whsec_b" },
  );
  const retryBody = await retry.json();

  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(retryBody.mode, "provisioning-replayed");
  assert.equal(retryBody.apiToken, firstBody.apiToken);
  assert.equal(retryBody.recoveryToken, firstBody.recoveryToken);
});

test("legacy bootstrap replay survives DEVICE_TOKEN_SECRET rollout after issuance", async () => {
  const deviceId = "10000000-0000-4000-8000-000000000013";

  const first = await apiRequest(
    "/auth/device-token",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deviceId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    },
    { STRIPE_WEBHOOK_SECRET: "whsec_before_rollout" },
  );
  const firstBody = await first.json();

  const retry = await apiRequest(
    "/auth/device-token",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deviceId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    },
    {
      DEVICE_TOKEN_SECRET: "device-token-secret-after-rollout",
      STRIPE_WEBHOOK_SECRET: "whsec_after_rollout",
    },
  );
  const retryBody = await retry.json();

  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(retryBody.mode, "provisioning-replayed");
  assert.equal(retryBody.apiToken, firstBody.apiToken);
  assert.equal(retryBody.recoveryToken, firstBody.recoveryToken);
});

test("legacy bootstrap replay survives DEVICE_TOKEN_SECRET rotation", async () => {
  const deviceId = "10000000-0000-4000-8000-000000000014";

  const first = await apiRequest(
    "/auth/device-token",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deviceId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    },
    { DEVICE_TOKEN_SECRET: "device-token-secret-a" },
  );
  const firstBody = await first.json();

  const retry = await apiRequest(
    "/auth/device-token",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deviceId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    },
    { DEVICE_TOKEN_SECRET: "device-token-secret-b" },
  );
  const retryBody = await retry.json();

  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(retryBody.mode, "provisioning-replayed");
  assert.equal(retryBody.apiToken, firstBody.apiToken);
  assert.equal(retryBody.recoveryToken, firstBody.recoveryToken);
});

test("concurrent legacy bootstrap retries replay a single credential pair", async () => {
  const deviceId = "10000000-0000-4000-8000-000000000004";

  const [first, second] = await Promise.all([
    apiRequest("/auth/device-token", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deviceId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    }),
    apiRequest("/auth/device-token", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deviceId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    }),
  ]);

  const firstBody = await first.json();
  const secondBody = await second.json();

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(firstBody.apiToken, secondBody.apiToken);
  assert.equal(firstBody.recoveryToken, secondBody.recoveryToken);
  assert.deepEqual(
    new Set([firstBody.mode, secondBody.mode]),
    new Set(["provisioned", "provisioning-replayed"])
  );
});

test("recovery retries replay the same rotated credentials until the new token is used", async () => {
  const deviceId = "10000000-0000-4000-8000-000000000005";
  const initial = await apiRequest("/auth/device-token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deviceId}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId }),
  });
  const initialBody = await initial.json();

  const recovered = await apiRequest("/auth/device-token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${initialBody.recoveryToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId }),
  });
  const recoveredBody = await recovered.json();

  const replayed = await apiRequest("/auth/device-token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${initialBody.recoveryToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId }),
  });
  const replayedBody = await replayed.json();

  assert.equal(recovered.status, 200);
  assert.equal(replayed.status, 200);
  assert.equal(replayedBody.mode, "recovery-replayed");
  assert.equal(replayedBody.apiToken, recoveredBody.apiToken);
  assert.equal(replayedBody.recoveryToken, recoveredBody.recoveryToken);

  const verified = await apiRequest("/auth/device-token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${recoveredBody.apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId }),
  });
  assert.equal(verified.status, 200);

  const staleRecovery = await apiRequest("/auth/device-token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${initialBody.recoveryToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId }),
  });
  assert.equal(staleRecovery.status, 401);
});

test("recovery replay survives RELAY_SECRET rotation", async () => {
  const deviceId = "10000000-0000-4000-8000-000000000008";
  const initial = await apiRequest(
    "/auth/device-token",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deviceId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    },
    { RELAY_SECRET: "relay-secret-a" },
  );
  const initialBody = await initial.json();

  const recovered = await apiRequest(
    "/auth/device-token",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${initialBody.recoveryToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    },
    { RELAY_SECRET: "relay-secret-a" },
  );
  const recoveredBody = await recovered.json();

  const replayed = await apiRequest(
    "/auth/device-token",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${initialBody.recoveryToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    },
    { RELAY_SECRET: "relay-secret-b" },
  );
  const replayedBody = await replayed.json();

  assert.equal(recovered.status, 200);
  assert.equal(replayed.status, 200);
  assert.equal(replayedBody.mode, "recovery-replayed");
  assert.equal(replayedBody.apiToken, recoveredBody.apiToken);
  assert.equal(replayedBody.recoveryToken, recoveredBody.recoveryToken);
});

test("recovery replay survives STRIPE_WEBHOOK_SECRET rotation", async () => {
  const deviceId = "10000000-0000-4000-8000-000000000012";
  const initial = await apiRequest(
    "/auth/device-token",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deviceId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    },
    { STRIPE_WEBHOOK_SECRET: "whsec_a" },
  );
  const initialBody = await initial.json();

  const recovered = await apiRequest(
    "/auth/device-token",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${initialBody.recoveryToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    },
    { STRIPE_WEBHOOK_SECRET: "whsec_a" },
  );
  const recoveredBody = await recovered.json();

  const replayed = await apiRequest(
    "/auth/device-token",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${initialBody.recoveryToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    },
    { STRIPE_WEBHOOK_SECRET: "whsec_b" },
  );
  const replayedBody = await replayed.json();

  assert.equal(recovered.status, 200);
  assert.equal(replayed.status, 200);
  assert.equal(replayedBody.mode, "recovery-replayed");
  assert.equal(replayedBody.apiToken, recoveredBody.apiToken);
  assert.equal(replayedBody.recoveryToken, recoveredBody.recoveryToken);
});

test("recovery replay survives DEVICE_TOKEN_SECRET rollout after issuance", async () => {
  const deviceId = "10000000-0000-4000-8000-000000000015";
  const initial = await apiRequest(
    "/auth/device-token",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deviceId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    },
    { STRIPE_WEBHOOK_SECRET: "whsec_before_rollout" },
  );
  const initialBody = await initial.json();

  const recovered = await apiRequest(
    "/auth/device-token",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${initialBody.recoveryToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    },
    { STRIPE_WEBHOOK_SECRET: "whsec_before_rollout" },
  );
  const recoveredBody = await recovered.json();

  const replayed = await apiRequest(
    "/auth/device-token",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${initialBody.recoveryToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    },
    {
      DEVICE_TOKEN_SECRET: "device-token-secret-after-rollout",
      STRIPE_WEBHOOK_SECRET: "whsec_after_rollout",
    },
  );
  const replayedBody = await replayed.json();

  assert.equal(recovered.status, 200);
  assert.equal(replayed.status, 200);
  assert.equal(replayedBody.mode, "recovery-replayed");
  assert.equal(replayedBody.apiToken, recoveredBody.apiToken);
  assert.equal(replayedBody.recoveryToken, recoveredBody.recoveryToken);
});

test("recovery replay survives DEVICE_TOKEN_SECRET rotation", async () => {
  const deviceId = "10000000-0000-4000-8000-000000000016";
  const initial = await apiRequest(
    "/auth/device-token",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deviceId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    },
    { DEVICE_TOKEN_SECRET: "device-token-secret-a" },
  );
  const initialBody = await initial.json();

  const recovered = await apiRequest(
    "/auth/device-token",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${initialBody.recoveryToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    },
    { DEVICE_TOKEN_SECRET: "device-token-secret-a" },
  );
  const recoveredBody = await recovered.json();

  const replayed = await apiRequest(
    "/auth/device-token",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${initialBody.recoveryToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    },
    { DEVICE_TOKEN_SECRET: "device-token-secret-b" },
  );
  const replayedBody = await replayed.json();

  assert.equal(recovered.status, 200);
  assert.equal(replayed.status, 200);
  assert.equal(replayedBody.mode, "recovery-replayed");
  assert.equal(replayedBody.apiToken, recoveredBody.apiToken);
  assert.equal(replayedBody.recoveryToken, recoveredBody.recoveryToken);
});

test("concurrent recovery retries replay a single rotated credential pair", async () => {
  const deviceId = "10000000-0000-4000-8000-000000000005";
  const initial = await apiRequest("/auth/device-token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deviceId}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId }),
  });
  const initialBody = await initial.json();

  const [first, second] = await Promise.all([
    apiRequest("/auth/device-token", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${initialBody.recoveryToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    }),
    apiRequest("/auth/device-token", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${initialBody.recoveryToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ deviceId }),
    }),
  ]);

  const firstBody = await first.json();
  const secondBody = await second.json();

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(firstBody.apiToken, secondBody.apiToken);
  assert.equal(firstBody.recoveryToken, secondBody.recoveryToken);
  assert.deepEqual(
    new Set([firstBody.mode, secondBody.mode]),
    new Set(["recovered", "recovery-replayed"])
  );
});

test("legacy bootstrap closes after the opaque token has been confirmed", async () => {
  const deviceId = "10000000-0000-4000-8000-000000000006";
  const provisioned = await apiRequest("/auth/device-token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deviceId}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId }),
  });
  const provisionedBody = await provisioned.json();

  const verified = await apiRequest("/auth/device-token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provisionedBody.apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId }),
  });
  assert.equal(verified.status, 200);

  const legacyRetry = await apiRequest("/auth/device-token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deviceId}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId }),
  });
  assert.equal(legacyRetry.status, 409);
});

test("opaque-token verification keeps legacy bootstrap available until a recovery token exists", async () => {
  const deviceId = "10000000-0000-4000-8000-000000000010";
  const apiToken = await registerDeviceApiToken({ deviceId });
  sqlite
    .prepare(
      `UPDATE device_api_tokens
          SET recovery_token_hash = NULL,
              legacy_bootstrap_allowed = 1
        WHERE device_id = ?`
    )
    .run(deviceId);

  const verified = await apiRequest("/auth/device-token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId }),
  });
  assert.equal(verified.status, 200);

  const legacyBootstrap = await apiRequest("/auth/device-token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deviceId}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceId }),
  });
  const bootstrapBody = await legacyBootstrap.json();
  assert.equal(legacyBootstrap.status, 200);
  assert.match(bootstrapBody.apiToken, /^s5_/);
  assert.match(bootstrapBody.recoveryToken, /^s5r_/);
});

test("/auth/authorize accepts appVersion from the JSON body when the header is missing", async () => {
  const deviceId = "10000000-0000-4000-8000-000000000017";
  await creditDevice({ deviceId, packId: "MICRO" });

  const allowed = await apiRequest(
    "/auth/authorize",
    {
      method: "POST",
      headers: {
        "X-Relay-Secret": "relay-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        apiKey: deviceId,
        appVersion: "1.13.0",
      }),
    },
    {
      MIN_TRANSLATOR_VERSION: "1.13.0",
      MIN_TRANSLATOR_VERSION_ENFORCEMENT: "enforce",
    }
  );
  assert.equal(allowed.status, 200);
  const allowedBody = await allowed.json();
  assert.equal(allowedBody.authorized, true);

  const blocked = await apiRequest(
    "/auth/authorize",
    {
      method: "POST",
      headers: {
        "X-Relay-Secret": "relay-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        apiKey: deviceId,
        appVersion: "1.12.6",
      }),
    },
    {
      MIN_TRANSLATOR_VERSION: "1.13.0",
      MIN_TRANSLATOR_VERSION_ENFORCEMENT: "enforce",
    }
  );
  assert.equal(blocked.status, 426);
  const blockedBody = await blocked.json();
  assert.equal(blockedBody.error, "update-required");
  assert.equal(blockedBody.clientVersion, "1.12.6");
  assert.equal(blockedBody.minVersion, "1.13.0");
});

test("device-token replay schema does not persist pending raw credentials", () => {
  const columns = sqlite
    .prepare("PRAGMA table_info(device_api_tokens)")
    .all()
    .map((row) => row.name);

  assert.ok(!columns.includes("pending_api_token"));
  assert.ok(!columns.includes("pending_recovery_token"));
});

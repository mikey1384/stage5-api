import assert from "node:assert/strict";
import test, { before, beforeEach } from "node:test";

import {
  creditDevice,
  ensureDatabase,
  mergeBillingReservationMeta,
  reserveBillingCredits,
} from "../src/lib/db.ts";
import {
  createRelayOwnedOwnership,
  createWorkerUploadingOwnership,
  resolveAbortReservationDisposition,
} from "../src/lib/direct-request-recovery.ts";
import {
  createSqliteD1Database,
  resetSqliteD1Database,
} from "./helpers/sqlite-d1.mjs";

const { sqlite, db } = createSqliteD1Database();

before(async () => {
  resetSqliteD1Database(sqlite);
  await ensureDatabase({ DB: db });
});

beforeEach(() => {
  resetSqliteD1Database(sqlite);
});

test("aborted worker uploads release reservations before relay ownership", async () => {
  const deviceId = "40000000-0000-4000-8000-000000000001";
  const requestKey = "transcription:uploading";
  await creditDevice({ deviceId, packId: "MICRO" });

  const reserved = await reserveBillingCredits({
    deviceId,
    service: "transcription",
    requestKey,
    spend: 120,
    reason: "TEST",
    meta: {
      directRequestOwnership: createWorkerUploadingOwnership(),
    },
  });

  assert.ok(reserved.ok);
  assert.equal(reserved.status, "reserved");

  const disposition = await resolveAbortReservationDisposition({
    deviceId,
    requestKey,
    service: "transcription",
    graceMs: 0,
  });

  assert.equal(disposition.action, "release");
});

test("aborted worker uploads preserve reservations once relay owns the request", async () => {
  const deviceId = "40000000-0000-4000-8000-000000000002";
  const requestKey = "transcription:relay-owned";
  await creditDevice({ deviceId, packId: "MICRO" });

  const reserved = await reserveBillingCredits({
    deviceId,
    service: "transcription",
    requestKey,
    spend: 120,
    reason: "TEST",
    meta: {
      directRequestOwnership: createWorkerUploadingOwnership(),
    },
  });

  assert.ok(reserved.ok);
  assert.equal(reserved.status, "reserved");

  const merged = await mergeBillingReservationMeta({
    deviceId,
    service: "transcription",
    requestKey,
    meta: {
      directRequestOwnership: createRelayOwnedOwnership(),
    },
  });

  assert.ok(merged.ok);

  const disposition = await resolveAbortReservationDisposition({
    deviceId,
    requestKey,
    service: "transcription",
    graceMs: 0,
  });

  assert.equal(disposition.action, "preserve");
});

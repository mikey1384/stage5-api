// The provisional transcription hold is max(duration, fileSize / floor). The
// app uploads 64 kbps Opus for Scribe; a 2,000 B/s floor made that hold ~4x
// the real cost and refused users who could afford the job (2026-10-12).
import assert from "node:assert/strict";
import test from "node:test";

import { resolveInitialReservationSeconds } from "../src/routes/transcribe.ts";

const OPUS_64K_BYTES_PER_SECOND = 8_000;
const WEBM_CONTAINER_OVERHEAD = 1.03;

test("a 64 kbps Opus upload holds about its real duration, not a multiple", () => {
  for (const seconds of [30, 600, 2622, 3 * 3600]) {
    const fileSizeBytes = Math.ceil(seconds * OPUS_64K_BYTES_PER_SECOND * WEBM_CONTAINER_OVERHEAD);
    const held = resolveInitialReservationSeconds({ requestedDurationSeconds: seconds, fileSizeBytes });
    assert(held <= Math.ceil(seconds * 1.1) + 2, `${seconds}s held ${held}s`);
  }
});

test("the size floor still guards uploads that under-report their duration", () => {
  const fileSizeBytes = 2622 * OPUS_64K_BYTES_PER_SECOND;
  const held = resolveInitialReservationSeconds({ requestedDurationSeconds: 10, fileSizeBytes });
  assert(held >= 2400, `held ${held}s`);
});

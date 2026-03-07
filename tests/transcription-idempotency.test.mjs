import assert from "node:assert/strict";
import test from "node:test";

import { buildDirectTranscriptionReservationKey } from "../src/lib/transcription-idempotency.ts";

test("direct transcription idempotency keys differ for different file contents with the same metadata", async () => {
  const baseRequest = {
    requestIdempotencyKey: "same-idempotency-key",
    deviceId: "50000000-0000-4000-8000-000000000001",
    requestedModel: "scribe_v2",
    qualityMode: "auto",
    language: "en",
    prompt: "test prompt",
  };

  const firstKey = await buildDirectTranscriptionReservationKey({
    ...baseRequest,
    file: new File(["aaaa"], "clip-a.mp3", { type: "audio/mpeg" }),
  });
  const secondKey = await buildDirectTranscriptionReservationKey({
    ...baseRequest,
    file: new File(["bbbb"], "clip-b.mp3", { type: "audio/mpeg" }),
  });
  const repeatedFirstKey = await buildDirectTranscriptionReservationKey({
    ...baseRequest,
    file: new File(["aaaa"], "clip-c.mp3", { type: "audio/mpeg" }),
  });

  assert.ok(firstKey);
  assert.ok(secondKey);
  assert.equal(firstKey, repeatedFirstKey);
  assert.notEqual(firstKey, secondKey);
});

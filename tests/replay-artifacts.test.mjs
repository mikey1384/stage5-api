import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteStoredJsonReplayArtifact,
  resolveStoredJsonReplay,
  storeSuccessJsonReplayArtifact,
} from "../src/lib/json-replay.ts";

class MemoryR2Bucket {
  #objects = new Map();

  async put(key, value) {
    const text =
      typeof value === "string" ? value : new TextDecoder().decode(value);
    this.#objects.set(key, text);
  }

  async get(key) {
    const text = this.#objects.get(key);
    if (typeof text !== "string") {
      return null;
    }

    return {
      async json() {
        return JSON.parse(text);
      },
    };
  }

  async delete(key) {
    this.#objects.delete(key);
  }

  has(key) {
    return this.#objects.has(key);
  }

  size() {
    return this.#objects.size;
  }
}

test("success replay artifacts round-trip through R2-backed references", async () => {
  const bucket = new MemoryR2Bucket();
  const storedReplay = await storeSuccessJsonReplayArtifact({
    bucket,
    service: "transcription",
    deviceId: "50000000-0000-4000-8000-000000000001",
    requestKey: "transcription:test-artifact",
    replay: {
      kind: "success",
      status: 200,
      body: {
        text: "hello",
        segments: [
          { text: "hello", start: 0, end: 1.25 },
        ],
      },
    },
  });

  assert.equal(storedReplay.kind, "success");
  assert.ok("artifact" in storedReplay);
  assert.equal(bucket.size(), 1);

  const replay = await resolveStoredJsonReplay({
    bucket,
    storedReplay,
  });
  assert.deepEqual(replay, {
    kind: "success",
    status: 200,
    body: {
      text: "hello",
      segments: [
        { text: "hello", start: 0, end: 1.25 },
      ],
    },
  });

  await deleteStoredJsonReplayArtifact({
    bucket,
    storedReplay,
  });
  assert.equal(bucket.has(storedReplay.artifact.key), false);
});

import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildDirectRelayTranscriptionRequestKey } from "../../openai-relay/relay/transcription-idempotency.ts";

test("relay direct transcription keys dedupe same-content retries across filenames", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "relay-transcribe-key-"));
  try {
    const firstPath = path.join(tempDir, "first.webm");
    const secondPath = path.join(tempDir, "second.webm");
    const content = Buffer.from("same audio bytes");
    await writeFile(firstPath, content);
    await writeFile(secondPath, content);

    const common = {
      deviceId: "60000000-0000-4000-8000-000000000001",
      clientIdempotencyKey: "idem-transcribe-1",
      language: "en",
      prompt: "speaker names",
      modelHint: "scribe_v2",
      modelIdHint: null,
      qualityMode: "true",
    };

    const firstKey = await buildDirectRelayTranscriptionRequestKey({
      ...common,
      filePath: firstPath,
    });
    const secondKey = await buildDirectRelayTranscriptionRequestKey({
      ...common,
      filePath: secondPath,
    });

    assert.equal(firstKey, secondKey);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("relay direct transcription keys diverge for different file contents", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "relay-transcribe-key-"));
  try {
    const firstPath = path.join(tempDir, "audio-a.webm");
    const secondPath = path.join(tempDir, "audio-b.webm");
    await writeFile(firstPath, Buffer.from("audio bytes A"));
    await writeFile(secondPath, Buffer.from("audio bytes B"));

    const common = {
      deviceId: "60000000-0000-4000-8000-000000000002",
      clientIdempotencyKey: "idem-transcribe-2",
      language: "en",
      prompt: "speaker names",
      modelHint: "scribe_v2",
      modelIdHint: null,
      qualityMode: "true",
    };

    const firstKey = await buildDirectRelayTranscriptionRequestKey({
      ...common,
      filePath: firstPath,
    });
    const secondKey = await buildDirectRelayTranscriptionRequestKey({
      ...common,
      filePath: secondPath,
    });

    assert.notEqual(firstKey, secondKey);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

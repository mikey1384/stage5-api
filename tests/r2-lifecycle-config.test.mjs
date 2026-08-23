import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const lifecycle = JSON.parse(
  fs.readFileSync(
    new URL("../config/r2-transcription-lifecycle.json", import.meta.url),
    "utf8",
  ),
);
const packageJson = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

test("transcription bucket lifecycle is limited to the intended prefixes and retention windows", () => {
  assert.equal(Array.isArray(lifecycle.rules), true);
  assert.equal(lifecycle.rules.length, 3);
  assert.equal(new Set(lifecycle.rules.map((rule) => rule.id)).size, 3);

  const multipart = lifecycle.rules.find(
    (rule) => rule.id === "Default Multipart Abort Rule",
  );
  assert.deepEqual(multipart.conditions, {});
  assert.equal(
    multipart.abortMultipartUploadsTransition.condition.maxAge,
    7 * 24 * 60 * 60,
  );

  const directReplay = lifecycle.rules.find(
    (rule) => rule.id === "Expire bounded direct replays",
  );
  assert.deepEqual(directReplay.conditions, { prefix: "direct-replay/" });
  assert.equal(
    directReplay.deleteObjectsTransition.condition.maxAge,
    2 * 24 * 60 * 60,
  );

  const uploads = lifecycle.rules.find(
    (rule) => rule.id === "Expire orphaned transcription uploads",
  );
  assert.deepEqual(uploads.conditions, { prefix: "transcriptions/" });
  assert.equal(
    uploads.deleteObjectsTransition.condition.maxAge,
    8 * 24 * 60 * 60,
  );

  for (const rule of lifecycle.rules) {
    assert.equal(rule.enabled, true);
  }
});

test("the lifecycle apply script replaces the bucket configuration from the reviewed file", () => {
  assert.equal(
    packageJson.scripts["r2:lifecycle:apply"],
    "wrangler r2 bucket lifecycle set stage5-transcription-uploads --file config/r2-transcription-lifecycle.json --force",
  );
});

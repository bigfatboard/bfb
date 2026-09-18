// ABOUTME: Locks the G02 evidence redaction scan to one needle per prohibited class.
// ABOUTME: Fails when a claimed class has no covering needle or a needle misses its class.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { G02_CANARIES, scanEvidenceText } from "./scan.ts";

const toolDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(toolDir, "../..");

test("every planted canary class is detected in a synthetic document", () => {
  for (const [key, value] of Object.entries(G02_CANARIES)) {
    assert.ok(
      scanEvidenceText(`evidence line carrying ${value} by accident`).includes(`canary:${key}`),
      `planted ${key} canary must hit`,
    );
  }
});

test("secret formats are detected without a planted canary", () => {
  const cases = [
    ["scratch dir /tmp/bfb-g02-abc123 leaks", "pattern:local_path"],
    ["home dir /home/operator/key leaks", "pattern:local_path"],
    ["mac path /Users/operator/secret leaks", "pattern:local_path"],
    ["folder /var/folders/zz/token leaks", "pattern:local_path"],
    ["windows path C:\\Temp\\secret leaks", "pattern:local_path"],
    ["key -----BEGIN PRIVATE KEY----- block", "pattern:private_key"],
    ["key -----BEGIN RSA PRIVATE KEY----- block", "pattern:private_key"],
    ["bare BEGIN PRIVATE KEY marker", "pattern:private_key"],
    ["header Authorization: Bearer abcDEF123_-.~+/=", "pattern:bearer_secret"],
    ["header session_cookie=abc123 sent", "pattern:cookie_value"],
    ["key AKIAIOSFODNN7EXAMPLE leaks", "pattern:provider_token"],
    ["token ghp_abc123DEF456 leaks", "pattern:provider_token"],
    ["token ghs_abc123DEF456 leaks", "pattern:provider_token"],
    ["token xoxb-1234-abcdef leaks", "pattern:provider_token"],
  ];
  for (const [text, hit] of cases) {
    assert.ok(scanEvidenceText(text).includes(hit), `${JSON.stringify(text)} must report ${hit}`);
  }
});

test("evidence prose and redacted placeholders stay clean", () => {
  const clean = [
    "task bodies, prompts, paths, hook payloads, artifact bytes, terminal output, cookies",
    "cookies, Bearer [REDACTED], or local absolute paths must not appear",
    "GitHub webhook dedupe converges; Terminal acceptance stays L05-owned",
    "hook launcher path is stable; token exchange completes; kid overlap holds",
    "synthetic document with counts only",
  ];
  for (const text of clean) {
    assert.deepEqual(scanEvidenceText(text), [], `${JSON.stringify(text)} must not hit`);
  }
});

test("committed G02 evidence carries no prohibited content", async () => {
  const manifest = JSON.parse(
    await readFile(resolve(root, "docs/work-packages/evidence/WP-G02/manifest.json"), "utf8"),
  );
  const scanFiles = manifest.artifacts
    .map((artifact) => artifact.split("/").pop())
    .filter((name) => name !== "redaction-scan.json");
  assert.ok(scanFiles.length >= 1, "the manifest lists the scanned evidence files");
  for (const name of scanFiles) {
    const text = await readFile(resolve(root, "docs/work-packages/evidence/WP-G02", name), "utf8");
    assert.deepEqual(scanEvidenceText(text), [], `${name} must scan clean`);
  }
});

test("every canary is planted in the gate flow and every claimed class is reported", async () => {
  const runSource = await readFile(resolve(root, "tools/g02/run.ts"), "utf8");
  assert.ok(runSource.includes("scanEvidenceText"), "run.ts scans evidence with scanEvidenceText");
  for (const key of Object.keys(G02_CANARIES)) {
    assert.ok(
      runSource.includes(`G02_CANARIES.${key}`),
      `G02_CANARIES.${key} must be planted in the flow, not only declared`,
    );
  }
  const manifest = JSON.parse(
    await readFile(resolve(root, "docs/work-packages/evidence/WP-G02/manifest.json"), "utf8"),
  );
  for (const claimed of manifest.redaction.prohibited_content) {
    assert.ok(
      runSource.includes(`"${claimed}"`),
      `run.ts must report the claimed prohibited class "${claimed}"`,
    );
  }
});

test("golden flow proves revocation and upgrade instead of labeling them", async () => {
  const runSource = await readFile(resolve(root, "tools/g02/run.ts"), "utf8");
  assert.ok(
    !/stage: "uninstall",/.test(runSource),
    'no bare "uninstall" stage may relabel runner revocation (binary removal is "uninstall binary")',
  );
  assert.ok(
    runSource.includes('stage: "runner revocation"'),
    "the revoke step is recorded as runner revocation",
  );
  assert.match(
    runSource,
    /stage: "upgrade"[\s\S]{0,400}re-migrat/,
    "the upgrade stage detail names the re-migration proof, not just the head",
  );
  // golden-flow.json is written deterministically from the same golden array
  // (prettier-formatted writeJson), so pinning the source pins the evidence.
  // Reading the committed file here would assert pre-regeneration state:
  // the gate regenerates it after the frozen-head drift is resolved.
});

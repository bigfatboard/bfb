// ABOUTME: Prepares a signed, isolated exact-Claude candidate build without activating any runtime.
// ABOUTME: Pins reviewed protocol metadata and binary bytes while leaving production manifests and user settings unchanged.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open, realpath, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSignedApp, run } from "../macos/build.mjs";

export const candidateVersion = "2.1.291";
export const candidatePackage = "./internal/providers/claude/testdata/pilot";
const hash = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const metadataText = (value) =>
  value === null ||
  (typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9._:/-]+$/u.test(value));
const hasOnly = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));

export function summarizeProbe(raw) {
  assert.ok(Buffer.byteLength(raw) <= 16384, "Probe metadata exceeds its bound");
  const entries = raw
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));
  assert.equal(entries.length, 2, "Use the complete bounded claude-mcp probe log");
  const [start, complete] = entries;
  assert.ok(hasOnly(start, ["phase", "version", "report_directory"]));
  assert.equal(start.phase, "start");
  assert.equal(start.version, candidateVersion + " (Claude Code)");
  assert.ok(
    hasOnly(complete, [
      "phase",
      "code",
      "signal",
      "timed_out",
      "output_limit",
      "output_bytes",
      "binary_unchanged",
      "records",
    ]),
  );
  assert.equal(complete.phase, "complete");
  assert.equal(complete.code, 0);
  assert.equal(complete.signal, null);
  assert.equal(complete.timed_out, false);
  assert.equal(complete.output_limit, false);
  assert.equal(complete.binary_unchanged, true);
  assert.ok(
    Number.isSafeInteger(complete.output_bytes) &&
      complete.output_bytes >= 0 &&
      complete.output_bytes <= 262144,
  );
  assert.ok(Array.isArray(complete.records) && complete.records.length <= 32);
  const methods = [],
    hooks = [];
  let initialized = false,
    notified = false;
  for (const record of complete.records) {
    if (record.surface === "mcp") {
      assert.ok(
        hasOnly(record, [
          "surface",
          "method",
          "protocol_version",
          "metadata_protocol_version",
          "capability_names",
          "client_name",
          "client_version",
        ]),
      );
      assert.ok(
        ["initialize", "notifications/initialized", "tools/list", "tools/call", "ping"].includes(
          record.method,
        ),
      );
      assert.ok(
        [
          record.protocol_version,
          record.metadata_protocol_version,
          record.client_name,
          record.client_version,
        ].every(metadataText),
      );
      assert.ok(
        Array.isArray(record.capability_names) &&
          record.capability_names.length <= 16 &&
          record.capability_names.every(metadataText),
      );
      if (record.method === "initialize") {
        assert.equal(initialized, false);
        assert.equal(record.protocol_version, "2025-11-25");
        assert.equal(record.client_name, "claude-code");
        assert.equal(record.client_version, candidateVersion);
        initialized = true;
      } else if (record.method === "notifications/initialized") {
        assert.ok(initialized && !notified);
        notified = true;
      } else {
        assert.ok(notified, "Tool operations must follow the initialized notification");
      }
      methods.push(record.method);
    } else {
      assert.ok(hasOnly(record, ["surface", "event", "source", "keys", "session_matches"]));
      assert.equal(record.surface, "hook");
      assert.ok(
        [
          "SessionStart",
          "UserPromptSubmit",
          "PreToolUse",
          "PostToolUse",
          "PostToolUseFailure",
          "Stop",
          "SessionEnd",
        ].includes(record.event),
      );
      assert.equal(record.session_matches, true);
      assert.ok([null, "startup", "resume", "clear", "compact", "fork"].includes(record.source));
      assert.ok(
        Array.isArray(record.keys) && record.keys.length <= 32 && record.keys.every(metadataText),
      );
      hooks.push(record.event);
    }
  }
  for (const method of ["initialize", "notifications/initialized", "tools/list", "tools/call"])
    assert.ok(methods.includes(method));
  for (const event of [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SessionEnd",
  ])
    assert.ok(hooks.includes(event));
  return {
    schema_version: 1,
    candidate_version: candidateVersion,
    protocol_version: "2025-11-25",
    probe_hash: hash(Buffer.from(raw)),
    methods,
    hook_events: [...new Set(hooks)].sort(),
    hook_deliveries: hooks.length,
    scope: "isolated_external_protocol_only",
  };
}

export async function fingerprintBinary(requested) {
  assert.ok(path.isAbsolute(requested), "An explicit absolute binary path is required");
  const binary = await realpath(requested);
  const file = await open(binary, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    assert.ok(before.isFile() && before.size > 0n && before.size <= 512n * 1024n * 1024n);
    assert.ok((before.mode & 0o111n) !== 0n && (before.mode & 0o022n) === 0n);
    assert.ok(before.uid === BigInt(process.getuid()) || before.uid === 0n);
    const digest = createHash("sha256");
    let bytes = 0n;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += BigInt(chunk.length);
      assert.ok(bytes <= before.size, "Binary grew while being fingerprinted");
      digest.update(chunk);
    }
    const after = await file.stat({ bigint: true });
    const currentPath = await realpath(requested);
    const current = await open(currentPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const identity = await current.stat({ bigint: true });
      assert.ok(
        currentPath === binary &&
          identity.dev === before.dev &&
          identity.ino === before.ino &&
          after.size === before.size &&
          after.mtimeNs === before.mtimeNs &&
          after.ctimeNs === before.ctimeNs &&
          bytes === before.size,
        "Binary changed while being fingerprinted",
      );
    } finally {
      await current.close();
    }
    return { binary_path: binary, binary_hash: "sha256:" + digest.digest("hex") };
  } finally {
    await file.close();
  }
}

export async function prepareCandidate({ binary, probeLog }) {
  const probeFile = await open(probeLog, constants.O_RDONLY | constants.O_NOFOLLOW);
  let metadata;
  try {
    const info = await probeFile.stat();
    assert.ok(
      info.isFile() && info.size <= 16384,
      "Use bounded metadata, never raw provider output",
    );
    metadata = summarizeProbe(await probeFile.readFile("utf8"));
  } finally {
    await probeFile.close();
  }
  const pin = await fingerprintBinary(binary);
  const home = homedir();
  assert.ok(path.isAbsolute(home) && path.resolve(home) === home);
  assert.ok(
    !process.env.BFB_CLAUDE_HOME || process.env.BFB_CLAUDE_HOME === home,
    "Candidate execution must use the existing native-auth home",
  );
  return {
    metadata,
    binding: {
      schema_version: 1,
      version: candidateVersion,
      home,
      ...pin,
      probe_hash: metadata.probe_hash,
    },
    report: {
      ...metadata,
      binary_hash: pin.binary_hash,
      binary_version_rechecked: false,
      tracked_launch_verified: false,
      same_run_resume_verified: false,
      production_support_changed: false,
      activation_performed: false,
    },
  };
}

// Building is deliberately separate from activation. This function never opens
// the app, launches its helper, writes Claude settings or enrolls a runner.
export async function buildCandidate(prepared, dependencies = {}) {
  const build = dependencies.buildSignedApp ?? buildSignedApp;
  const execute = dependencies.run ?? run;
  const before = await fingerprintBinary(prepared.binding.binary_path);
  assert.equal(
    before.binary_hash,
    prepared.binding.binary_hash,
    "Reviewed binary changed before build",
  );
  const root = await mkdtemp("/tmp/bfb-l04-l07-");
  const state = path.join(root, "state");
  await mkdir(state, { mode: 0o700 });
  const artifact = await build({
    configuration: "Debug",
    helperPackage: candidatePackage,
    testStateDirectory: state,
  });
  assert.equal(
    path.resolve(artifact.helper),
    path.join(path.resolve(artifact.app), "Contents/Helpers/bfb"),
  );
  const binding = { ...prepared.binding, state_directory: state };
  await writeFile(
    path.join(artifact.app, "Contents/Resources/claude-candidate.json"),
    JSON.stringify(binding),
    { mode: 0o600, flag: "wx" },
  );
  // The additional pin resource must be sealed before the app can be used.
  await execute("/usr/bin/codesign", [
    "--force",
    "--sign",
    artifact.identity,
    "--identifier",
    "com.qdis.bfb",
    "--options",
    "runtime",
    "--entitlements",
    path.join(artifact.directory, "BFB.entitlements"),
    artifact.app,
  ]);
  await execute("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    artifact.app,
  ]);
  const after = await fingerprintBinary(prepared.binding.binary_path);
  assert.equal(after.binary_hash, before.binary_hash, "Reviewed binary changed during build");
  const plan = {
    schema_version: 1,
    app: artifact.app,
    helper: artifact.helper,
    state_directory: state,
    report: prepared.report,
    human_activation_required: true,
    service_installation_allowed: false,
    provider_settings_changed: false,
    enrolled: false,
    live_acceptance: "not_run",
  };
  const planPath = path.join(root, "candidate-plan.json");
  await writeFile(planPath, JSON.stringify(plan, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return { ...plan, planPath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try {
    const args = process.argv.slice(2);
    const mode = args.shift();
    assert.ok(
      mode === "--dry-run" || mode === "--build",
      "Use --dry-run or --build; there is no activation mode",
    );
    const options = {};
    while (args.length) {
      const key = args.shift();
      assert.ok(["--binary", "--probe-log"].includes(key) && args.length && !options[key]);
      options[key] = args.shift();
    }
    assert.ok(options["--binary"] && options["--probe-log"]);
    const prepared = await prepareCandidate({
      binary: options["--binary"],
      probeLog: options["--probe-log"],
    });
    console.log(
      JSON.stringify(mode === "--dry-run" ? prepared.report : await buildCandidate(prepared)),
    );
  } catch {
    console.error(JSON.stringify({ error: { code: "candidate_preflight_failed" } }));
    process.exitCode = 1;
  }
}

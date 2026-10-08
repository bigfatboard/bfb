// ABOUTME: Checks candidate preparation and build sealing without executing a provider or native runtime.
// ABOUTME: Uses metadata-only fixtures and stubbed build commands to preserve activation and production boundaries.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildCandidate,
  candidatePackage,
  fingerprintBinary,
  prepareCandidate,
  summarizeProbe,
} from "./claude-bfb.mjs";

function probeLog() {
  const mcp = (method) => ({
    surface: "mcp",
    method,
    protocol_version: method === "initialize" ? "2025-11-25" : null,
    metadata_protocol_version: null,
    capability_names: [],
    client_name: method === "initialize" ? "claude-code" : null,
    client_version: method === "initialize" ? "2.1.291" : null,
  });
  const hooks = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SessionEnd",
  ].map((event) => ({
    surface: "hook",
    event,
    source: event === "SessionStart" ? "startup" : null,
    keys: ["session_id", "hook_event_name"],
    session_matches: true,
  }));
  return (
    [
      JSON.stringify({
        phase: "start",
        version: "2.1.291 (Claude Code)",
        report_directory: "/private/synthetic-metadata",
      }),
      JSON.stringify({
        phase: "complete",
        code: 0,
        signal: null,
        timed_out: false,
        output_limit: false,
        output_bytes: 100,
        binary_unchanged: true,
        records: [
          mcp("initialize"),
          mcp("notifications/initialized"),
          mcp("tools/list"),
          mcp("tools/call"),
          ...hooks,
        ],
      }),
    ].join("\n") + "\n"
  );
}

async function fixture(t) {
  const directory = await mkdtemp("/tmp/bfb-candidate-unit-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "claude");
  const probe = path.join(directory, "probe.jsonl");
  // Intentionally non-runnable content: tests never execute this file.
  await writeFile(binary, "synthetic executable bytes", { mode: 0o700 });
  await writeFile(probe, probeLog(), { mode: 0o600 });
  return { directory, binary, probe };
}

test("dry preparation keeps all live/certification claims false and redacts local paths", async (t) => {
  const { binary, probe } = await fixture(t);
  const prepared = await prepareCandidate({ binary, probeLog: probe });
  for (const key of [
    "binary_version_rechecked",
    "tracked_launch_verified",
    "same_run_resume_verified",
    "production_support_changed",
    "activation_performed",
  ])
    assert.equal(prepared.report[key], false);
  const report = JSON.stringify(prepared.report);
  assert.ok(
    !report.includes(binary) && !report.includes("/private/") && !report.includes(process.env.HOME),
  );
  assert.equal(prepared.metadata.scope, "isolated_external_protocol_only");
});

test("metadata rejects private values, changed version, skipped initialization and unsuccessful probes", () => {
  const entries = probeLog().trim().split("\n").map(JSON.parse);
  for (const change of [
    (value) => {
      value[0].version = "2.1.292 (Claude Code)";
    },
    (value) => {
      value[1].code = 1;
    },
    (value) => {
      value[1].binary_unchanged = false;
    },
    (value) => {
      value[1].records[0].prompt = "private-canary";
    },
    (value) => {
      value[1].records.splice(1, 1);
    },
    (value) => {
      value[1].records.at(-1).session_matches = false;
    },
  ]) {
    const value = structuredClone(entries);
    change(value);
    assert.throws(() => summarizeProbe(value.map((entry) => JSON.stringify(entry)).join("\n")));
  }
  assert.throws(() => summarizeProbe(" ".repeat(16385)));
});

test("signed build uses the fixed helper and private state, seals pin, and performs no activation", async (t) => {
  const { directory, binary, probe } = await fixture(t);
  const prepared = await prepareCandidate({ binary, probeLog: probe });
  const commands = [];
  const result = await buildCandidate(prepared, {
    buildSignedApp: async (options) => {
      assert.equal(options.configuration, "Debug");
      assert.equal(options.helperPackage, candidatePackage);
      assert.match(options.testStateDirectory, /^\/tmp\/bfb-l04-l07-[A-Za-z0-9]+\/state$/u);
      t.after(() => rm(path.dirname(options.testStateDirectory), { recursive: true, force: true }));
      const app = path.join(directory, "BFB.app");
      await mkdir(path.join(app, "Contents/Resources"), { recursive: true });
      return {
        app,
        helper: path.join(app, "Contents/Helpers/bfb"),
        directory,
        identity: "synthetic-signing-identity",
      };
    },
    run: async (command, args) => commands.push([command, args]),
  });
  assert.equal(commands.length, 2);
  assert.ok(commands.every(([command]) => command === "/usr/bin/codesign"));
  assert.ok(commands[1][1].includes("--strict"));
  const binding = JSON.parse(
    await readFile(path.join(result.app, "Contents/Resources/claude-candidate.json"), "utf8"),
  );
  assert.equal(binding.binary_hash, prepared.binding.binary_hash);
  assert.equal(binding.state_directory, result.state_directory);
  assert.equal(result.live_acceptance, "not_run");
  assert.equal(result.enrolled, false);
  assert.equal(result.provider_settings_changed, false);
  assert.equal(result.service_installation_allowed, false);
});

test("binary changes between preparation and build reject before any build command", async (t) => {
  const { binary, probe } = await fixture(t);
  const prepared = await prepareCandidate({ binary, probeLog: probe });
  await writeFile(binary, "replaced synthetic bytes", { mode: 0o700 });
  let called = false;
  await assert.rejects(
    buildCandidate(prepared, {
      buildSignedApp: async () => {
        called = true;
      },
    }),
  );
  assert.equal(called, false);
  assert.notEqual((await fingerprintBinary(binary)).binary_hash, prepared.binding.binary_hash);
});

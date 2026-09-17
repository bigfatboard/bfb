// ABOUTME: Drives the real bfb mcp stdio binary through startup, purity, and offline cases.
// ABOUTME: Uses synthetic identities only and asserts on stderr/stdout boundaries, never bodies.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const binary = join(
  mkdtempSync(join(tmpdir(), "bfb-a01-harness-")),
  "bfb",
);

function build(): void {
  const result = spawnSync("go", ["build", "-o", binary, "./cmd/bfb"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `go build failed: ${result.stderr}`);
}

function scopedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("BFB_") && value !== undefined) {
      env[key] = value;
    }
  }
  return {
    ...env,
    BFB_WORKSPACE_ID: "01SYNTHETICWS00000000000001",
    BFB_PROJECT_ID: "01SYNTHETICPR00000000000001",
    BFB_TASK_ID: "01SYNTHETICTA00000000000001",
    BFB_RUN_ID: "01SYNTHETICRU00000000000001",
    BFB_RUN_EXECUTION_ID: "01SYNTHETICEX00000000000001",
    BFB_ASSIGNMENT_GENERATION: "7",
    BFB_CHECKOUT_ID: "01SYNTHETICCO00000000000001",
    BFB_CORRELATION_TOKEN: "synthetic-harness-correlation-001",
    BFB_ARTIFACTS_DIR: mkdtempSync(join(tmpdir(), "bfb-a01-artifacts-")),
    BFB_RUNNER_ID: "01SYNTHETICRN00000000000001",
    ...extra,
  };
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function serve(args: string[], stdin: string, env: Record<string, string>): Run {
  const result = spawnSync(binary, args, {
    cwd: root,
    env,
    input: stdin,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function sessionLine(id: number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function assertPureJsonRpc(stdout: string, expected: number, codes: string[]): void {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, expected, `stdout lines:\n${stdout}`);
  lines.forEach((line, index) => {
    const value = JSON.parse(line) as {
      jsonrpc?: string;
      error?: { data?: { bfb_code?: string } };
    };
    assert.equal(value.jsonrpc, "2.0", `line ${index} not JSON-RPC: ${line}`);
    assert.equal(value.error?.data?.bfb_code, codes[index], `line ${index}: ${line}`);
  });
}

function assertNoLeak(text: string): void {
  for (const secret of ["synthetic-harness-correlation", "BFB_RUNNER_TOKEN"]) {
    assert.ok(!text.includes(secret), `leaked material in: ${text.slice(0, 200)}`);
  }
}

build();

// Unknown execution: every request fails visibly as assignment_unknown on pure stdout.
{
  const dataDir = mkdtempSync(join(tmpdir(), "bfb-a01-data-"));
  const stdin = [
    sessionLine(1, "initialize", {}),
    sessionLine(2, "tools/list", {}),
    sessionLine(3, "tools/call", {
      name: "bfb_get_task",
      arguments: { request_id: "harness-001" },
    }),
  ].join("\n") + "\n";
  const run = serve(["--data-dir", dataDir, "mcp", "stdio"], stdin, scopedEnv());
  assert.equal(run.status, 0, `exit: ${run.stderr}`);
  assertPureJsonRpc(run.stdout, 3, [
    "assignment_unknown",
    "assignment_unknown",
    "assignment_unknown",
  ]);
  assertNoLeak(run.stdout);
  assertNoLeak(run.stderr);
  assert.ok(
    existsSync(join(dataDir, "local-mcp-journal.sqlite")),
    "journal file was not created",
  );
}

// Missing environment: refusal with empty stdout.
{
  const dataDir = mkdtempSync(join(tmpdir(), "bfb-a01-data-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("BFB_") && value !== undefined) {
      env[key] = value;
    }
  }
  const run = serve(["--data-dir", dataDir, "mcp", "stdio"], "", env);
  assert.equal(run.status, 2, `exit: ${run.stderr}`);
  assert.equal(run.stdout, "", `stdout not empty: ${run.stdout}`);
}

// Bearer in the provider environment: refusal with empty stdout.
{
  const dataDir = mkdtempSync(join(tmpdir(), "bfb-a01-data-"));
  const run = serve(
    ["--data-dir", dataDir, "mcp", "stdio"],
    "",
    scopedEnv({ BFB_RUNNER_TOKEN: "synthetic-bearer" }),
  );
  assert.equal(run.status, 2, `exit: ${run.stderr}`);
  assert.equal(run.stdout, "", `stdout not empty: ${run.stdout}`);
  assertNoLeak(run.stdout);
  assertNoLeak(run.stderr);
}

// Unexpected arguments: usage refusal with empty stdout.
{
  const dataDir = mkdtempSync(join(tmpdir(), "bfb-a01-data-"));
  const run = serve(
    ["--data-dir", dataDir, "mcp", "stdio", "--verbose"],
    "",
    scopedEnv(),
  );
  assert.equal(run.status, 2, `exit: ${run.stderr}`);
  assert.equal(run.stdout, "", `stdout not empty: ${run.stdout}`);
}

// Journal carries migration 011 even though the assignment is unknown.
{
  const dataDir = mkdtempSync(join(tmpdir(), "bfb-a01-data-"));
  serve(["--data-dir", dataDir, "mcp", "stdio"], "", scopedEnv());
  const journal = join(dataDir, "local-mcp-journal.sqlite");
  assert.ok(existsSync(journal), "journal file missing");
  const header = readFileSync(journal, "utf8").slice(0, 16);
  assert.ok(header.startsWith("SQLite format 3"), `not a SQLite file: ${header}`);
}

console.log("local MCP stdio harness: passed (unknown-assignment visibility, stdout purity, env refusal, journal creation)");

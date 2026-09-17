// ABOUTME: Drives the real bfb run submit binary through journaling and rejection cases.
// ABOUTME: Uses synthetic identities only and asserts on stdout lines, never bodies.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const binary = join(mkdtempSync(join(tmpdir(), "bfb-a03-harness-")), "bfb");
const correlation = "synthetic-harness-correlation-002";

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
    BFB_CORRELATION_TOKEN: correlation,
    BFB_ARTIFACTS_DIR: mkdtempSync(join(tmpdir(), "bfb-a03-artifacts-")),
    BFB_RUNNER_ID: "01SYNTHETICRN00000000000001",
    ...extra,
  };
}

function seedAssignments(path: string, state: string, token: string): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE local_execution_assignments (
execution_id TEXT, assignment_generation INTEGER, state TEXT, correlation_token TEXT,
workspace_id TEXT, project_id TEXT, task_id TEXT, run_id TEXT, runner_id TEXT, checkout_id TEXT,
supervisor_json TEXT, owned_group_json TEXT)`);
  db.prepare(
    `INSERT INTO local_execution_assignments
(execution_id, assignment_generation, state, correlation_token, workspace_id, project_id,
 task_id, run_id, runner_id, checkout_id)
VALUES (?, 7, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "01SYNTHETICEX00000000000001",
    state,
    token,
    "01SYNTHETICWS00000000000001",
    "01SYNTHETICPR00000000000001",
    "01SYNTHETICTA00000000000001",
    "01SYNTHETICRU00000000000001",
    "01SYNTHETICRN00000000000001",
    "01SYNTHETICCO00000000000001",
  );
  db.close();
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function submit(args: string[], env: Record<string, string>, dataDir: string): Run {
  const result = spawnSync(binary, ["--data-dir", dataDir, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function receipt(stdout: string): Record<string, unknown> {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 1, `stdout lines:\n${stdout}`);
  return JSON.parse(lines[0] as string) as Record<string, unknown>;
}

function assertNoLeak(text: string): void {
  for (const secret of [correlation, "synthetic-harness-bearer"]) {
    assert.ok(!text.includes(secret), `leaked material in: ${text.slice(0, 200)}`);
  }
}

build();

const submitArgs = [
  "run",
  "submit",
  "--summary",
  "Synthetic harness result",
  "--evidence-ref",
  "comment:synthetic-harness-comment@1",
  "--git-branch",
  "main",
  "--git-commit",
  "c".repeat(40),
  "--request-id",
  "a03-harness-submit-001",
];

// Bound run: one pending_sync receipt, repeat returns the original, journal created.
{
  const dataDir = mkdtempSync(join(tmpdir(), "bfb-a03-data-"));
  seedAssignments(join(dataDir, "state.sqlite"), "running", correlation);
  const first = submit(submitArgs, scopedEnv(), dataDir);
  assert.equal(first.status, 0, `exit: ${first.stderr}\n${first.stdout}`);
  const firstReceipt = receipt(first.stdout);
  assert.equal(firstReceipt["status"], "pending_sync");
  assert.equal(firstReceipt["request_id"], "a03-harness-submit-001");
  assert.equal(firstReceipt["tool"], "bfb_submit_result");
  assertNoLeak(first.stdout);
  assertNoLeak(first.stderr);
  assert.ok(existsSync(join(dataDir, "local-mcp-journal.sqlite")), "journal file missing");
  const second = submit(submitArgs, scopedEnv(), dataDir);
  assert.equal(second.status, 0, `repeat exit: ${second.stderr}`);
  assert.deepEqual(receipt(second.stdout), firstReceipt);
}

// Wrong correlation: visible rejection with no journaled effect.
{
  const dataDir = mkdtempSync(join(tmpdir(), "bfb-a03-data-"));
  seedAssignments(join(dataDir, "state.sqlite"), "running", "another-correlation");
  const run = submit(submitArgs, scopedEnv(), dataDir);
  assert.notEqual(run.status, 0);
  const failure = receipt(run.stdout)["error"] as { code?: string };
  assert.equal(failure.code, "correlation_rejected");
  assertNoLeak(run.stdout);
  assertNoLeak(run.stderr);
}

// Bearer-polluted environment: refusal before any storage effect.
{
  const dataDir = mkdtempSync(join(tmpdir(), "bfb-a03-data-"));
  seedAssignments(join(dataDir, "state.sqlite"), "running", correlation);
  const run = submit(submitArgs, scopedEnv({ BFB_RUNNER_TOKEN: "synthetic-harness-bearer" }), dataDir);
  assert.notEqual(run.status, 0);
  const failure = receipt(run.stdout)["error"] as { code?: string };
  assert.equal(failure.code, "invalid_request");
  assertNoLeak(run.stdout);
  assertNoLeak(run.stderr);
  assert.ok(!existsSync(join(dataDir, "local-mcp-journal.sqlite")), "refused run journaled");
}

console.log("A03 CLI submit harness: passed");

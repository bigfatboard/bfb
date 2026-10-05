// ABOUTME: Proves the real reserved run submit command validates inputs without opening journal storage.
// ABOUTME: Uses synthetic identities and byte-preserved historical rows without admitting result writes.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const binary = join(mkdtempSync(join(tmpdir(), "bfb-reserved-results-harness-")), "bfb");
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
    BFB_ARTIFACTS_DIR: mkdtempSync(join(tmpdir(), "bfb-reserved-results-artifacts-")),
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
  for (const secret of [
    correlation,
    "synthetic-harness-bearer",
    "Synthetic harness result",
    "synthetic-harness-comment",
  ]) {
    assert.ok(!text.includes(secret), `leaked material in: ${text.slice(0, 200)}`);
  }
}

function assertNoJournal(dataDir: string): void {
  assert.ok(
    !readdirSync(dataDir).some((name) => name.startsWith("local-mcp-journal.sqlite")),
    "reserved result command touched A01 journal state",
  );
}

function assertUnsupported(run: Run): void {
  assert.equal(run.status, 4, `exit: ${run.stderr}\n${run.stdout}`);
  assert.equal(run.stdout, '{"error":{"code":"not_implemented"}}\n');
  assert.deepEqual(receipt(run.stdout), { error: { code: "not_implemented" } });
  assertNoLeak(run.stdout);
  assertNoLeak(run.stderr);
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
  "reserved-harness-submit-001",
];

// Valid input is unsupported without opening either assignment or journal storage.
{
  const dataDir = mkdtempSync(join(tmpdir(), "bfb-reserved-results-data-"));
  const first = submit(submitArgs, scopedEnv(), dataDir);
  assertUnsupported(first);
  const second = submit(submitArgs, scopedEnv(), dataDir);
  assertUnsupported(second);
  assert.equal(second.stdout, first.stdout);
  assertNoJournal(dataDir);
  assert.ok(!existsSync(join(dataDir, "state.sqlite")), "assignment storage created");
}

// Assignment contents cannot enable this held result-write surface.
for (const [state, token] of [
  ["running", correlation],
  ["running", "another-correlation"],
  ["ended", correlation],
] as const) {
  const dataDir = mkdtempSync(join(tmpdir(), "bfb-reserved-results-data-"));
  const assignments = join(dataDir, "state.sqlite");
  seedAssignments(assignments, state, token);
  const original = readFileSync(assignments);
  assertUnsupported(submit(submitArgs, scopedEnv(), dataDir));
  assert.deepEqual(readFileSync(assignments), original, "assignment history changed");
  assertNoJournal(dataDir);
}

// Existing unsigned pending and terminal history remain byte-for-byte historical evidence.
{
  const dataDir = mkdtempSync(join(tmpdir(), "bfb-reserved-results-history-"));
  const journal = join(dataDir, "local-mcp-journal.sqlite");
  const db = new DatabaseSync(journal);
  db.exec(
    readFileSync(join(root, "internal/localmcp/migrations/011_pending_operations.sql"), "utf8"),
  );
  db.exec("PRAGMA user_version = 12");
  const insert = db.prepare(
    `INSERT INTO pending_operations
    (request_id, tool, workspace_id, project_id, task_id, run_id, runner_id, checkout_id,
     execution_id, assignment_generation, observed_session_id, principal, grant_name,
     expected_version, payload_hash, payload_json, capture_proof, captured_at, expires_at,
     policy_decision, state, outcome_json)
    VALUES (?, 'bfb_submit_result', 'workspace', 'project', 'task', 'run', 'runner', 'checkout',
     'execution', 7, '', 'legacy', 'legacy', 0, 'legacy-hash', '{}', 'unsigned-legacy',
     '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'pending_sync', ?, ?)`,
  );
  insert.run("legacy-pending-result-001", "pending", null);
  insert.run("legacy-terminal-result-001", "applied", '{"historical":true}');
  db.close();
  const original = readFileSync(journal);
  const originalFiles = readdirSync(dataDir).sort();
  assertUnsupported(submit(submitArgs, scopedEnv(), dataDir));
  assert.deepEqual(readFileSync(journal), original, "retained journal bytes changed");
  assert.deepEqual(readdirSync(dataDir).sort(), originalFiles, "journal sidecar created");
}

// Existing input and environment validation still refuses malformed callers before storage.
for (const [args, extra, code] of [
  [submitArgs, { BFB_RUNNER_TOKEN: "synthetic-harness-bearer" }, "invalid_request"],
  [submitArgs, { BFB_RUN_ID: "" }, "invalid_request"],
  [submitArgs, { BFB_ASSIGNMENT_GENERATION: "0" }, "invalid_request"],
  [[...submitArgs, "--unknown", "value"], {}, "invalid_request"],
  [["run", "submit", "--summary", "x", "--request-id", "invalid request"], {}, "invalid_request"],
  [
    [
      "run",
      "submit",
      "--summary",
      "x",
      "--request-id",
      "valid-request-001",
      "--git-commit",
      "short",
    ],
    {},
    "invalid_params",
  ],
] satisfies Array<[string[], Record<string, string>, string]>) {
  const dataDir = mkdtempSync(join(tmpdir(), "bfb-reserved-results-refused-"));
  const run = submit(args, scopedEnv(extra), dataDir);
  assert.equal(run.status, 2, `exit: ${run.stderr}\n${run.stdout}`);
  const failure = receipt(run.stdout)["error"] as { code?: string };
  assert.equal(failure.code, code);
  assertNoLeak(run.stdout);
  assertNoLeak(run.stderr);
  assertNoJournal(dataDir);
  assert.ok(
    !existsSync(join(dataDir, "state.sqlite")),
    "refused command opened assignment storage",
  );
}

console.log("Reserved results CLI harness: passed");

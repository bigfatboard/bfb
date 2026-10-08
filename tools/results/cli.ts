// ABOUTME: Tests the real protected result CLI with peer checks and synthetic closed v5 responses.
// ABOUTME: Verifies safe projections and exit categories without opening daemon journal history.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod } from "node:fs/promises";
import { createServer } from "node:net";
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
    BFB_WORKSPACE_ID: "01K6R7DT00AAAAAAAAAAAAAAAA",
    BFB_PROJECT_ID: "01K6R7DT00BBBBBBBBBBBBBBBB",
    BFB_TASK_ID: "01K6R7DT00CCCCCCCCCCCCCCCC",
    BFB_RUN_ID: "01K6R7DT00DDDDDDDDDDDDDDDD",
    BFB_RUN_EXECUTION_ID: "01K6R7DT00EEEEEEEEEEEEEEEE",
    BFB_ASSIGNMENT_GENERATION: "7",
    BFB_CHECKOUT_ID: "01K6R7DT00FFFFFFFFFFFFFFFF",
    BFB_CORRELATION_TOKEN: correlation,
    BFB_ARTIFACTS_DIR: mkdtempSync(join(tmpdir(), "bfb-reserved-results-artifacts-")),
    BFB_RUNNER_ID: "01K6R7DT00GGGGGGGGGGGGGGGG",
    ...extra,
  };
}

function seedAssignments(path: string, state: string, token: string, owned = false): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE local_execution_assignments (
execution_id TEXT, assignment_generation INTEGER, state TEXT, correlation_token TEXT,
workspace_id TEXT, project_id TEXT, task_id TEXT, run_id TEXT, runner_id TEXT, checkout_id TEXT,
supervisor_json TEXT, owned_group_json TEXT)`);
  db.exec(
    "CREATE TABLE execution_native_history (execution_id TEXT PRIMARY KEY, history_json TEXT)",
  );
  db.prepare(
    `INSERT INTO local_execution_assignments
(execution_id, assignment_generation, state, correlation_token, workspace_id, project_id,
 task_id, run_id, runner_id, checkout_id)
VALUES (?, 7, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "01K6R7DT00EEEEEEEEEEEEEEEE",
    state,
    token,
    "01K6R7DT00AAAAAAAAAAAAAAAA",
    "01K6R7DT00BBBBBBBBBBBBBBBB",
    "01K6R7DT00CCCCCCCCCCCCCCCC",
    "01K6R7DT00DDDDDDDDDDDDDDDD",
    "01K6R7DT00GGGGGGGGGGGGGGGG",
    "01K6R7DT00FFFFFFFFFFFFFFFF",
  );
  if (owned) {
    const group = Number(
      spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {
        encoding: "utf8",
      }).stdout.trim(),
    );
    assert.ok(Number.isSafeInteger(group) && group > 1);
    db.prepare("UPDATE local_execution_assignments SET owned_group_json = ?").run(
      JSON.stringify({ pid: group, group_id: group, start_identity: "synthetic-retained-group" }),
    );
  }
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

function assertRefused(run: Run, code = "assignment_unknown"): void {
  assert.equal(run.status, 3, `exit: ${run.stderr}\n${run.stdout}`);
  assert.deepEqual(receipt(run.stdout), { error: { code } });
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

// Missing local authority cannot create either assignment or journal storage.
{
  const dataDir = mkdtempSync(join(tmpdir(), "bfb-reserved-results-data-"));
  const first = submit(submitArgs, scopedEnv(), dataDir);
  assertRefused(first);
  const second = submit(submitArgs, scopedEnv(), dataDir);
  assertRefused(second);
  assert.equal(second.stdout, first.stdout);
  assertNoJournal(dataDir);
  assert.ok(!existsSync(join(dataDir, "state.sqlite")), "assignment storage created");
}

// Missing peer ownership or an ended assignment refuses before transport.
for (const [state, token] of [
  ["running", correlation],
  ["running", "another-correlation"],
  ["ended", correlation],
] as const) {
  const dataDir = mkdtempSync(join(tmpdir(), "bfb-reserved-results-data-"));
  const assignments = join(dataDir, "state.sqlite");
  seedAssignments(assignments, state, token);
  const original = readFileSync(assignments);
  assertRefused(
    submit(submitArgs, scopedEnv(), dataDir),
    state === "ended" ? "assignment_ended" : "peer_denied",
  );
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
  assertRefused(submit(submitArgs, scopedEnv(), dataDir));
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

// Real binary and parent/group checks exercise v5 wire delivery, not native
// business admission. The separate signed native gate verifies that authority.
for (const state of [
  "committed",
  "pending_sync",
  "applied",
  "delivery_blocked",
  "rejected",
  "denied",
] as const) {
  const dataDir = mkdtempSync(join(tmpdir(), "bfb-result-v5-"));
  seedAssignments(join(dataDir, "state.sqlite"), "running", correlation, true);
  let observed: Record<string, unknown> | undefined;
  const server = createServer((socket) => {
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffered += chunk;
      while (buffered.includes("\n")) {
        const index = buffered.indexOf("\n");
        const request = JSON.parse(buffered.slice(0, index)) as Record<string, unknown>;
        buffered = buffered.slice(index + 1);
        if (request.method === "daemon.status") {
          socket.write(
            JSON.stringify({
              ...request,
              direction: "response",
              payload: { methods: ["mcp.v5.submit_result"] },
            }) + "\n",
          );
          continue;
        }
        assert.equal(request.schema_version, 5);
        assert.equal(request.method, "mcp.v5.submit_result");
        const local = (request.payload as Record<string, Record<string, unknown>>)
          .agent_result_request!;
        observed = local;
        const reference = (local.request as Record<string, Record<string, unknown>>).reference!;
        const identity = { tool: "submit_result", ...reference };
        const canonical = JSON.stringify(
          Object.fromEntries(Object.entries(identity).sort(([a], [b]) => (a < b ? -1 : 1))),
        );
        const resultReceipt = {
          schema_version: 1,
          operation_key: "agent:" + createHash("sha256").update(canonical).digest("hex"),
          request_id: "reserved-harness-submit-001",
          tool: "bfb_submit_result",
          admission_mode: "offline_admitted",
          delivery_state: state,
          effect_certainty:
            state === "applied"
              ? "confirmed"
              : state === "delivery_blocked"
                ? "possibly_applied"
                : "not_attempted",
          captured_at: "2026-10-06T12:00:00.000Z",
          intent_expires_at: "2026-10-06T12:05:00.000Z",
          reason_code:
            state === "delivery_blocked"
              ? "work_unavailable"
              : state === "rejected"
                ? "invalid_transition"
                : null,
        };
        const result = {
          submission_id: "01K6R7DT00CCCCCCCCCCCCCCCC",
          version: 1,
          result_state: "submitted",
          task_state: "review",
          run_version: 2,
          task_version: 2,
          origin: {
            run_id: "01K6R7DT00DDDDDDDDDDDDDDDD",
            run_execution_id: "01K6R7DT00EEEEEEEEEEEEEEEE",
            assignment_generation: 7,
            provider_session_id: "01K6R7DT00HHHHHHHHHHHHHHHH",
          },
        };
        socket.end(
          JSON.stringify({
            schema_version: 5,
            request_id: request.request_id,
            method: request.method,
            direction: "response",
            ...(state === "denied"
              ? {
                  error: {
                    schema_version: 1,
                    category: "authorization_denied",
                    code: "forbidden",
                    message: "Result unavailable",
                  },
                }
              : {
                  payload:
                    state === "committed"
                      ? { agent_result: result }
                      : { agent_result_receipt: resultReceipt },
                }),
          }) + "\n",
        );
      }
    });
  });
  const socketPath = join(dataDir, "daemon.sock");
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  await chmod(socketPath, 0o600);
  const input = [
    "run",
    "submit",
    "--summary",
    "  Synthetic harness result  ",
    "--limitations",
    "",
    "--evidence-refs-json",
    "[]",
    "--request-id",
    "reserved-harness-submit-001",
  ];
  const run = await new Promise<Run>((resolve, reject) => {
    const child = spawn(binary, ["--data-dir", dataDir, ...input], {
      cwd: root,
      env: scopedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  assert.equal(
    run.status,
    state === "delivery_blocked" ? 4 : state === "rejected" ? 6 : state === "denied" ? 3 : 0,
    run.stdout,
  );
  const value = receipt(run.stdout);
  if (state === "committed") {
    assert.equal(value.version, 1);
    assert.equal(value.task_state, "review");
  } else if (state !== "denied") {
    assert.equal(value.delivery_state, state);
    assert.equal(
      value.reason_code,
      state === "delivery_blocked"
        ? "work_unavailable"
        : state === "rejected"
          ? "invalid_transition"
          : null,
    );
  }
  assert.ok(observed);
  assert.ok(!("expected_binding" in observed));
  const original = observed.request as Record<string, unknown>;
  assert.equal(original.summary, "  Synthetic harness result  ");
  assert.equal(original.limitations, "");
  assert.deepEqual(original.evidence_refs, []);
  assert.ok(!("binding" in original));
  assertNoLeak(run.stdout);
  assertNoLeak(run.stderr);
  assertNoJournal(dataDir);
}

console.log(
  "Protected results CLI harness: passed (synthetic v5 transport; native admission is a separate gate)",
);

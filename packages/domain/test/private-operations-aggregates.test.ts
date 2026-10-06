// ABOUTME: Proves operations queue and health totals resolve supported current shared sources.
// ABOUTME: Observer scope, exact lineage, malformed history and final-selection races fence aggregates.

import type { SqlDatabase } from "@bfb/db";
import { describe, expect, it } from "vitest";
import { FIX } from "../src/fixtures.js";
import { randomUlid } from "../src/ids.js";
import {
  collectWorkspaceHealth,
  readOperationsProjection,
  readQueueState,
  recoveryActionId,
  listStuckLaunches,
  listStuckUploads,
  listRetentionEligibleChunks,
  type QueueState,
  type OpsRecoveryKind,
} from "../src/operations.js";
import type { TaskAccessContext } from "../src/task-access.js";
import { launchFixture } from "./launch-fixture.js";

const NOW = "2026-09-12T13:00:00.000Z";
const OLD = "2026-09-12T12:00:00.000Z";
const access = (humanId = FIX.owner, authorizationEpoch = 1): TaskAccessContext => ({
  workspaceId: FIX.workspace,
  humanId,
  authorizationEpoch,
});
const EMPTY: QueueState = {
  notifications: { pending: 0, dead_lettered: 0, failed: 0 },
  github_outbox: { pending: 0, dispatched_stale: 0, dlq: 0 },
  ops_recovery: { applied: 0, failed: 0 },
};
const read = (db: SqlDatabase, context = access()) =>
  readQueueState(db, FIX.workspace, NOW, context);

async function fixture() {
  const f = await launchFixture(undefined, { taskCreatorHumanId: FIX.member });
  const claimed = await f.claim();
  return { ...f, launch: claimed.launch, cursor: 1000 };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function privacy(f: Fixture) {
  await f.db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, f.task.id, FIX.member, NOW);
}
async function event(f: Fixture, kind: string, value: unknown) {
  const cursor = ++f.cursor;
  await f.db
    .prepare(
      "INSERT INTO semantic_events (workspace_id,event_id,workspace_cursor,kind,payload_json,created_at) VALUES (?,?,?,?,?,?)",
    )
    .run(
      FIX.workspace,
      randomUlid(),
      cursor,
      kind,
      typeof value === "string" ? value : JSON.stringify(value),
      OLD,
    );
  return cursor;
}
async function attention(f: Fixture) {
  const id = randomUlid();
  await f.db
    .prepare(
      `INSERT INTO attention_requests (workspace_id,id,project_id,task_id,run_id,run_execution_id,assignment_generation,kind,required_role,question,blocking,state,requested_at,resource_version)
    VALUES (?,?,?,?,?,?,?,'clarification','member','Synthetic aggregate attention',0,'open',?,1)`,
    )
    .run(
      FIX.workspace,
      id,
      FIX.projectA,
      f.task.id,
      f.launch.run_id,
      f.launch.run_execution_id,
      f.launch.assignment_generation,
      OLD,
    );
  return id;
}
async function notification(
  f: Fixture,
  options: {
    state?: string;
    kind?: string;
    category?: string;
    value?: unknown;
    recipient?: string;
  } = {},
) {
  const id = await attention(f),
    kind = options.kind ?? "attention.request",
    value = options.value ?? { actor: {}, input: {}, result: { id, state: "open" } },
    cursor = await event(f, kind, value),
    deliveryId = randomUlid();
  await f.db
    .prepare(
      `INSERT INTO notification_deliveries (workspace_id,delivery_id,channel,human_id,event_cursor,event_kind,category,state,created_at,updated_at)
    VALUES (?,?,'macos',?,?,?,?,?,?,?)`,
    )
    .run(
      FIX.workspace,
      deliveryId,
      options.recipient ?? FIX.reviewer,
      cursor,
      kind,
      options.category ?? "attention",
      options.state ?? "pending",
      OLD,
      OLD,
    );
  return { id, cursor, deliveryId, value };
}
async function installation(f: Fixture, status = "active") {
  await f.db
    .prepare(
      `INSERT INTO github_app_installations (workspace_id,installation_id,app_id,app_slug,account_id,account_login,account_type,status,permissions_json,events_json,created_at,updated_at,resource_version)
    VALUES (?,'123','234','synthetic','345','synthetic','Organization',?,'{}','[]',?,?,1)`,
    )
    .run(FIX.workspace, status, OLD, OLD);
}
async function github(
  f: Fixture,
  options: {
    event?: string;
    action?: string | null;
    state?: string;
    ref?: string;
    effect?: unknown;
    status?: string;
  } = {},
) {
  const exists = await f.db
    .prepare("SELECT 1 FROM github_app_installations WHERE workspace_id=?")
    .get(FIX.workspace);
  if (!exists) await installation(f, options.status);
  if ((options.event ?? "push") !== "installation") {
    const link = await f.db
      .prepare("SELECT 1 FROM github_repository_links WHERE workspace_id=?")
      .get(FIX.workspace);
    if (!link)
      await f.db
        .prepare(
          `INSERT INTO github_repository_links (workspace_id,id,repository_id,installation_id,project_id,full_name,default_branch,link_state,created_at,resource_version)
      VALUES (?,?,'456','123',?,'synthetic/repository','main','active',?,1)`,
        )
        .run(FIX.workspace, randomUlid(), FIX.projectA, OLD);
  }
  const deliveryId = randomUlid(),
    outboxId = randomUlid(),
    name = options.event ?? "push",
    action = options.action === undefined ? null : options.action,
    effect = options.effect ?? {
      event: name,
      action,
      installationId: "123",
      repositoryId: name === "installation" ? null : "456",
      occurredAt: OLD,
      ref: name === "installation" ? null : (options.ref ?? "main"),
      version: name === "installation" ? null : "abcdef",
      detail: {},
    };
  await f.db
    .prepare(
      `INSERT INTO github_webhook_deliveries (workspace_id,delivery_id,event,action,installation_id,repository_id,effect_json,state,received_at)
    VALUES (?,?,?,?,'123',?,?,'received',?)`,
    )
    .run(
      FIX.workspace,
      deliveryId,
      name,
      action,
      name === "installation" ? null : "456",
      JSON.stringify(effect),
      OLD,
    );
  await f.db
    .prepare(
      `INSERT INTO github_integration_outbox (workspace_id,outbox_id,delivery_id,kind,state,attempts,next_attempt_at,created_at,updated_at)
    VALUES (?,?,?,'github.reconcile',?,0,?,?,?)`,
    )
    .run(FIX.workspace, outboxId, deliveryId, options.state ?? "pending", OLD, OLD, OLD);
  return { deliveryId, outboxId, effect };
}
async function evidence(
  f: Fixture,
  kind: string,
  ref: string,
  options: {
    observedBy?: string;
    taskId?: string | null;
    projectId?: string;
    version?: string;
  } = {},
) {
  await f.db
    .prepare(
      `INSERT INTO github_evidence (workspace_id,id,project_id,task_id,repository_id,kind,ref,version_token,state_json,observed_by,observed_at,resource_version)
    VALUES (?,?,?,?,'456',?,?,?,'{}',?,?,1)`,
    )
    .run(
      FIX.workspace,
      randomUlid(),
      options.projectId ?? FIX.projectA,
      options.taskId === undefined ? f.task.id : options.taskId,
      kind,
      ref,
      options.version ?? "newer-version",
      options.observedBy ?? "github",
      OLD,
    );
}
async function failedVersion(f: Fixture, runId: string | null = f.launch.run_id, state = "failed") {
  const artifactId = randomUlid(),
    versionId = randomUlid();
  await f.db
    .prepare(
      "INSERT INTO artifacts (workspace_id,id,run_id,format,role,created_by_human_id,created_at) VALUES (?,?,?,'log','log',?,?)",
    )
    .run(FIX.workspace, artifactId, runId, FIX.member, OLD);
  await f.db
    .prepare(
      "INSERT INTO artifact_versions (workspace_id,id,artifact_id,state,format,declared_size,expected_digest,created_at) VALUES (?,?,?,?,'log',64,?,?)",
    )
    .run(FIX.workspace, versionId, artifactId, state, "a".repeat(64), OLD);
  return versionId;
}
async function malformedRun(f: Fixture) {
  const id = `${randomUlid()}\u0000synthetic`;
  // Synthetic historical corruption retains a genuine shared task/project, not forged author authority.
  await f.db
    .prepare(
      `INSERT INTO runs (workspace_id,id,project_id,task_id,requested_by_human_id,agent_profile_id,result_state,activity,resource_version,created_at)
    SELECT workspace_id,?,project_id,task_id,requested_by_human_id,agent_profile_id,result_state,activity,resource_version,created_at
    FROM runs WHERE workspace_id=? AND id=?`,
    )
    .run(id, FIX.workspace, f.launch.run_id);
  return id;
}
async function retentionVersion(f: Fixture, runId: string) {
  const artifactId = randomUlid(),
    versionId = randomUlid(),
    at = "2026-08-01T12:00:00.000Z";
  await f.db
    .prepare(
      "INSERT INTO artifacts (workspace_id,id,run_id,format,role,created_by_human_id,created_at) VALUES (?,?,?,'log','log',?,?)",
    )
    .run(FIX.workspace, artifactId, runId, FIX.member, at);
  await f.db
    .prepare(
      `INSERT INTO artifact_versions (workspace_id,id,artifact_id,state,format,declared_size,expected_digest,content_hash,r2_key,created_at,available_at)
    VALUES (?,?,?,'available','log',64,?,?,?,?,?)`,
    )
    .run(
      FIX.workspace,
      versionId,
      artifactId,
      "a".repeat(64),
      "b".repeat(64),
      `workspaces/${FIX.workspace}/runs/${runId}/logs/${versionId}.jsonl.zst`,
      at,
      at,
    );
  return versionId;
}
async function recovery(
  f: Fixture,
  kind: OpsRecoveryKind,
  target: unknown,
  result: unknown,
  state = "applied",
) {
  const id = recoveryActionId(
    kind,
    typeof target === "string" ? { synthetic: target } : (target as Record<string, unknown>),
  );
  await f.db
    .prepare(
      `INSERT INTO ops_recovery_ledger (workspace_id,action_id,kind,target_json,state,attempt_count,result_json,created_by_human_id,created_at,updated_at)
    VALUES (?,?,?,?,?,1,?,?,?,?)`,
    )
    .run(
      FIX.workspace,
      id,
      kind,
      typeof target === "string" ? target : JSON.stringify(target),
      state,
      typeof result === "string" ? result : JSON.stringify(result),
      FIX.owner,
      OLD,
      OLD,
    );
  return id;
}
async function delivery(
  f: Fixture,
  cursor: number,
  kind: string,
  category: string,
  state = "pending",
) {
  await f.db
    .prepare(
      `INSERT INTO notification_deliveries (workspace_id,delivery_id,channel,human_id,event_cursor,event_kind,category,state,created_at,updated_at)
    VALUES (?,?,'macos',?,?,?,?,?,?,?)`,
    )
    .run(FIX.workspace, randomUlid(), FIX.reviewer, cursor, kind, category, state, OLD, OLD);
}
async function submission(f: Fixture) {
  const id = randomUlid(),
    run = (await f.db
      .prepare(
        "SELECT id AS config_snapshot_id,content_hash AS config_hash FROM run_configuration_snapshots WHERE workspace_id=? AND run_id=?",
      )
      .get(FIX.workspace, f.launch.run_id)) as { config_snapshot_id: string; config_hash: string };
  await f.db
    .prepare(
      `INSERT INTO result_submissions (workspace_id,id,run_id,version,summary,evidence_refs_json,config_snapshot_id,config_hash,submitted_by_kind,submitted_by_id,submitted_at)
    VALUES (?,?,?,1,'Synthetic aggregate result','[]',?,?,'human',?,?)`,
    )
    .run(
      FIX.workspace,
      id,
      f.launch.run_id,
      run.config_snapshot_id,
      run.config_hash,
      FIX.member,
      OLD,
    );
  return id;
}
async function rotate(db: SqlDatabase) {
  await db
    .prepare(
      "UPDATE workspace_members SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
    )
    .run(FIX.workspace, FIX.owner);
  await db
    .prepare(
      "UPDATE workspace_authorization_epochs SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
    )
    .run(FIX.workspace, FIX.owner);
}
async function restrict(db: SqlDatabase) {
  await db
    .prepare("UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id=?")
    .run(FIX.workspace, FIX.projectA);
  await db
    .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
    .run(FIX.workspace, FIX.projectA, FIX.owner);
}
function beforeFinal(db: SqlDatabase, change: () => Promise<void>): SqlDatabase {
  let fired = false;
  return {
    ...db,
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!sql.includes("visible_notifications AS MATERIALIZED")) return statement;
      return {
        ...statement,
        async get(...params) {
          if (!fired) {
            fired = true;
            await change();
          }
          return statement.get(...params);
        },
      };
    },
  };
}

describe("scoped operations aggregates", () => {
  it("counts visible notification rows for an observer other than the stored recipient", async () => {
    const f = await fixture();
    await notification(f);
    expect((await read(f.db)).notifications.pending).toBe(1);
  });
  it("excludes private notification history even for its creator and grantees", async () => {
    const f = await fixture();
    await notification(f);
    await privacy(f);
    expect(await read(f.db, access(FIX.member))).toEqual(EMPTY);
  });
  it("does not count unrelated semantic commands as notifications", async () => {
    const f = await fixture();
    await notification(f, { kind: "task.update" });
    expect(await read(f.db)).toEqual(EMPTY);
  });
  it("excludes a pending GitHub effect whose canonical evidence is private", async () => {
    const f = await fixture();
    await github(f);
    await evidence(f, "branch", "main");
    await privacy(f);
    expect(await read(f.db)).toEqual(EMPTY);
  });
  it("excludes unsupported GitHub installation repository effects uniformly", async () => {
    const f = await fixture();
    await github(f, { event: "installation_repositories", action: "added" });
    expect(await read(f.db)).toEqual(EMPTY);
  });
  it("omits an applied recovery row containing one private failed target", async () => {
    const f = await fixture(),
      bound = await failedVersion(f),
      free = await failedVersion(f, null);
    await recovery(f, "resolve_stuck_upload", { version_ids: [free, bound] }, { resolved: 2 });
    await privacy(f);
    expect(await read(f.db)).toEqual(EMPTY);
  });
  it("does not count failed or cleared recovery history as supported applied work", async () => {
    const f = await fixture();
    await recovery(f, "clear_recovery_state", { action_ids: [randomUlid()] }, { cleared: 1 });
    await recovery(
      f,
      "resolve_stuck_upload",
      { version_ids: [await failedVersion(f)] },
      { resolved: 1 },
      "failed",
    );
    expect(await read(f.db)).toEqual(EMPTY);
  });
  it("denies stale observer epochs even when every source set is empty", async () => {
    const f = await fixture();
    await expect(read(f.db, access(FIX.owner, 2))).rejects.toMatchObject({
      code: "not_found",
      message: "operations scope not found",
    });
  });
  it("denies human health without an explicit retained observer", async () => {
    const f = await fixture();
    await expect(
      collectWorkspaceHealth(f.db, FIX.workspace, NOW, undefined as unknown as TaskAccessContext),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });
  it.each(["pending", "dead_lettered", "failed"])(
    "counts the notification %s bucket once per delivery",
    async (state) => {
      const f = await fixture();
      await notification(f, { state });
      const result = await read(f.db);
      expect(result.notifications).toEqual({ ...EMPTY.notifications, [state]: 1 });
    },
  );
  it("retains answered attention and revoked recipient history without contact prerequisites", async () => {
    const f = await fixture(),
      n = await notification(f);
    await f.db
      .prepare(
        "UPDATE attention_requests SET state='answered',answer='Synthetic response' WHERE workspace_id=? AND id=?",
      )
      .run(FIX.workspace, n.id);
    await f.db
      .prepare(
        "UPDATE workspace_authorization_epochs SET revoked_at=? WHERE workspace_id=? AND human_id=?",
      )
      .run(NOW, FIX.workspace, FIX.reviewer);
    expect((await read(f.db)).notifications.pending).toBe(1);
  });
  it.each(["read", "contribute", "edit"])(
    "private %s grants do not widen operator counts",
    async (permission) => {
      const f = await fixture();
      await notification(f);
      await privacy(f);
      await f.db
        .prepare(
          "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,permission,authorization_epoch,created_at) VALUES (?,?,?,?,?,1,?)",
        )
        .run(FIX.workspace, randomUlid(), f.task.id, FIX.owner, permission, OLD);
      expect(await read(f.db)).toEqual(EMPTY);
    },
  );
  it.each([
    ["launch.reject", { state: "rejected" }],
    ["launch.claim", { state: "expired", reason: "launch_expired" }],
    ["launch.authorize", { decision: "rejected", rejection: { code: "launch_blocked" } }],
  ])("recognizes exact %s retained launch sources", async (kind, result) => {
    const f = await fixture(),
      cursor = await event(f, kind, {
        actor: {},
        input: { launchId: f.launch.launch_id },
        result: {
          ...result,
          ...(kind === "launch.authorize" ? { launch_id: f.launch.launch_id } : {}),
        },
      });
    await delivery(f, cursor, kind, "launch_blocked");
    expect((await read(f.db)).notifications.pending).toBe(1);
    await privacy(f);
    expect(await read(f.db)).toEqual(EMPTY);
  });
  it.each([
    ["result.submit", "result_submitted", "submitted"],
    ["result.request_changes", "result_changes_requested", "changes_requested"],
    ["result.accept", "result_accepted", "accepted"],
    ["result.fail", "run_failed", "failed"],
    ["result.cancel", "run_cancelled", "cancelled"],
  ])(
    "recognizes exact %s source and retained submission association",
    async (kind, category, state) => {
      const f = await fixture(),
        id = await submission(f),
        cursor = await event(f, kind, {
          actor: {},
          input: { runId: f.launch.run_id, submissionId: id },
          result: {
            runResultState: state,
            taskState: "review",
            submission: { id, run_id: f.launch.run_id, version: 1 },
          },
        });
      await delivery(f, cursor, kind, category);
      expect((await read(f.db)).notifications.pending).toBe(1);
      await privacy(f);
      expect(await read(f.db)).toEqual(EMPTY);
    },
  );
  it.each([
    "null",
    "scalar",
    "root_duplicate",
    "input_string",
    "result_string",
    "result_duplicate",
    "child_run",
    "child_task",
    "child_project",
    "missing_child",
    "wrong_category",
    "wrong_kind",
  ])("excludes malformed notification source %s", async (corruption) => {
    const f = await fixture(),
      n = await notification(f);
    if (
      corruption === "child_run" ||
      corruption === "child_task" ||
      corruption === "child_project"
    ) {
      const column =
        corruption === "child_run"
          ? "run_id"
          : corruption === "child_task"
            ? "task_id"
            : "project_id";
      await f.db
        .prepare(`UPDATE attention_requests SET ${column}=? WHERE workspace_id=? AND id=?`)
        .run(randomUlid(), FIX.workspace, n.id);
    } else if (corruption === "wrong_category")
      await f.db
        .prepare("UPDATE notification_deliveries SET category='run_failed' WHERE delivery_id=?")
        .run(n.deliveryId);
    else if (corruption === "wrong_kind")
      await f.db
        .prepare("UPDATE notification_deliveries SET event_kind='result.fail' WHERE delivery_id=?")
        .run(n.deliveryId);
    else {
      let value = JSON.stringify(n.value);
      if (corruption === "null") value = "null";
      else if (corruption === "scalar") value = '"synthetic"';
      else if (corruption === "root_duplicate")
        value = `{"input":{},"input":{},"result":{"id":"${n.id}","state":"open"}}`;
      else if (corruption === "input_string")
        value = JSON.stringify({ input: "{}", result: { id: n.id, state: "open" } });
      else if (corruption === "result_string")
        value = JSON.stringify({ input: {}, result: JSON.stringify({ id: n.id, state: "open" }) });
      else if (corruption === "result_duplicate")
        value = `{"input":{},"result":{"id":"${n.id}","id":"${n.id}","state":"open"}}`;
      else value = JSON.stringify({ input: {}, result: { id: randomUlid(), state: "open" } });
      await f.db
        .prepare(
          "UPDATE semantic_events SET payload_json=? WHERE workspace_id=? AND workspace_cursor=?",
        )
        .run(value, FIX.workspace, n.cursor);
    }
    expect(await read(f.db)).toEqual(EMPTY);
  });
  it.each(["result.request_changes", "result.accept", "result.fail", "result.cancel"])(
    "does not redirect %s using unrelated result.run_id",
    async (kind) => {
      const f = await fixture(),
        id = await submission(f),
        states: { [key: string]: string } = {
          "result.request_changes": "changes_requested",
          "result.accept": "accepted",
          "result.fail": "failed",
          "result.cancel": "cancelled",
        },
        categories: { [key: string]: string } = {
          "result.request_changes": "result_changes_requested",
          "result.accept": "result_accepted",
          "result.fail": "run_failed",
          "result.cancel": "run_cancelled",
        },
        cursor = await event(f, kind, {
          input: { runId: randomUlid(), submissionId: id },
          result: { run_id: f.launch.run_id, runResultState: states[kind] },
        });
      await delivery(f, cursor, kind, categories[kind]!);
      expect(await read(f.db)).toEqual(EMPTY);
    },
  );
  it.each([
    "push",
    "pull_request",
    "check_run",
    "check_suite",
    "status",
    "issues",
    "deployment",
    "deployment_status",
  ])("counts pending project-only GitHub %s before evidence exists", async (name) => {
    const f = await fixture();
    await github(f, { event: name });
    expect((await read(f.db)).github_outbox.pending).toBe(1);
  });
  it.each([
    ["push", "branch"],
    ["pull_request", "pull_request"],
    ["check_run", "check"],
    ["check_suite", "check"],
    ["status", "check"],
    ["issues", "issue"],
    ["deployment", "deployment"],
    ["deployment_status", "deployment"],
  ])("filters applicable GitHub %s/%s task evidence", async (name, kind) => {
    const f = await fixture();
    await github(f, { event: name });
    await evidence(f, kind, "main");
    await privacy(f);
    expect(await read(f.db)).toEqual(EMPTY);
  });
  it.each(["abcdef", "main:deleted"])(
    "checks the retained push commit %s independently of branch evidence",
    async (ref) => {
      const f = await fixture();
      await github(f, {
        effect: {
          event: "push",
          action: null,
          installationId: "123",
          repositoryId: "456",
          occurredAt: OLD,
          ref: "main",
          version: ref.includes(":") ? "deleted" : "abcdef",
          detail: {},
        },
      });
      await evidence(f, "branch", "main", { taskId: null });
      await evidence(f, "commit", ref);
      await privacy(f);
      expect(await read(f.db)).toEqual(EMPTY);
    },
  );
  it.each(["human", "runner", "unrelated_kind", "unrelated_ref"])(
    "keeps GitHub lineage distinct from %s evidence",
    async (source) => {
      const f = await fixture();
      await github(f);
      await evidence(
        f,
        source === "unrelated_kind" ? "issue" : "branch",
        source === "unrelated_ref" ? "elsewhere" : "main",
        { observedBy: source === "human" || source === "runner" ? source : "github" },
      );
      await privacy(f);
      expect((await read(f.db)).github_outbox.pending).toBe(1);
    },
  );
  it("does not demand that newer GitHub evidence version equals a queued older effect", async () => {
    const f = await fixture();
    await github(f);
    await evidence(f, "branch", "main", { version: "newer-sha" });
    expect((await read(f.db)).github_outbox.pending).toBe(1);
  });
  it.each(["pending", "active", "suspended", "revoked"])(
    "retains pure installation lifecycle in %s status",
    async (status) => {
      const f = await fixture();
      await github(f, { event: "installation", action: "deleted", status });
      expect((await read(f.db)).github_outbox.pending).toBe(1);
    },
  );
  it.each(["created", "deleted", "suspend", "unsuspend"])(
    "recognizes installation %s history",
    async (action) => {
      const f = await fixture();
      await github(f, { event: "installation", action });
      expect((await read(f.db)).github_outbox.pending).toBe(1);
    },
  );
  it.each([
    "event",
    "action",
    "null_action",
    "installation",
    "repository",
    "serialized",
    "duplicate",
    "nul_installation",
    "nul_ref",
    "unknown_event",
    "closed_link",
    "revoked_installation",
    "wrong_project",
  ])("excludes malformed or inaccessible GitHub source %s", async (corruption) => {
    const f = await fixture(),
      g = await github(f),
      effect = g.effect as Record<string, unknown>;
    if (corruption === "closed_link")
      await f.db
        .prepare("UPDATE github_repository_links SET link_state='closed' WHERE workspace_id=?")
        .run(FIX.workspace);
    else if (corruption === "revoked_installation")
      await f.db
        .prepare(
          "UPDATE github_app_installations SET status='revoked',revoked_at=? WHERE workspace_id=?",
        )
        .run(NOW, FIX.workspace);
    else if (corruption === "wrong_project") {
      await evidence(f, "branch", "main", { projectId: FIX.projectB });
    } else {
      let value = JSON.stringify(effect);
      if (corruption === "serialized") value = JSON.stringify(value);
      else if (corruption === "duplicate")
        value = value.replace('"event":"push"', '"event":"push","event":"push"');
      else {
        if (corruption === "event") effect.event = "issues";
        else if (corruption === "action") effect.action = "opened";
        else if (corruption === "null_action") delete effect.action;
        else if (corruption === "installation") effect.installationId = "999";
        else if (corruption === "repository") effect.repositoryId = "999";
        else if (corruption === "nul_installation") effect.installationId = "123\u0000synthetic";
        else if (corruption === "nul_ref") effect.ref = "main\u0000synthetic";
        else effect.event = "unknown";
        value = JSON.stringify(effect);
      }
      await f.db
        .prepare(
          "UPDATE github_webhook_deliveries SET effect_json=? WHERE workspace_id=? AND delivery_id=?",
        )
        .run(value, FIX.workspace, g.deliveryId);
    }
    expect(await read(f.db)).toEqual(EMPTY);
  });
  it("counts exact DLQ associations without multiplying evidence joins", async () => {
    const f = await fixture(),
      g = await github(f, { state: "dispatched" });
    await evidence(f, "branch", "main");
    await evidence(f, "commit", "abcdef");
    await f.db
      .prepare(
        "INSERT INTO github_dlq (workspace_id,outbox_id,delivery_id,kind,error,attempts,created_at) VALUES (?,?,?,'github.reconcile','synthetic',5,?)",
      )
      .run(FIX.workspace, g.outboxId, g.deliveryId, OLD);
    expect((await read(f.db)).github_outbox).toEqual({ pending: 0, dispatched_stale: 1, dlq: 1 });
    await f.db
      .prepare("UPDATE github_dlq SET delivery_id=? WHERE workspace_id=? AND outbox_id=?")
      .run(randomUlid(), FIX.workspace, g.outboxId);
    expect((await read(f.db)).github_outbox.dlq).toBe(0);
  });
  it("retains legitimate duplicate notification and GitHub recovery targets", async () => {
    const f = await fixture(),
      n = await notification(f),
      g = await github(f, { state: "done" });
    await recovery(
      f,
      "retry_notification_dispatch",
      { cursors: [n.cursor, n.cursor] },
      { redispatched_from: n.cursor - 1, cursors: 2 },
    );
    await recovery(
      f,
      "requeue_github_outbox",
      { outbox_ids: [g.outboxId, g.outboxId] },
      { requeued: 2 },
    );
    await recovery(
      f,
      "resolve_stuck_upload",
      { version_ids: [await failedVersion(f, null)] },
      { resolved: 1 },
    );
    expect((await read(f.db)).ops_recovery).toEqual({ applied: 3, failed: 0 });
  });
  it("requires no notification delivery for semantic retry history", async () => {
    const f = await fixture(),
      id = await attention(f),
      cursor = await event(f, "attention.request", { input: {}, result: { id, state: "open" } });
    await recovery(
      f,
      "retry_notification_dispatch",
      { cursors: [cursor] },
      { redispatched_from: cursor - 1, cursors: 1 },
    );
    expect((await read(f.db)).ops_recovery.applied).toBe(1);
  });
  it.each(["retry_notification_dispatch", "requeue_github_outbox"] as const)(
    "omits %s recovery with a missing target in a mixed set",
    async (kind) => {
      const f = await fixture(),
        n = await notification(f),
        g = await github(f);
      await recovery(
        f,
        kind,
        kind === "retry_notification_dispatch"
          ? { cursors: [n.cursor, n.cursor + 1] }
          : { outbox_ids: [g.outboxId, randomUlid()] },
        kind === "retry_notification_dispatch"
          ? { redispatched_from: n.cursor - 1, cursors: 2 }
          : { requeued: 2 },
      );
      expect((await read(f.db)).ops_recovery.applied).toBe(0);
    },
  );
  it.each([
    "scalar",
    "string_array",
    "duplicate_key",
    "duplicate_ids",
    "wrong_count",
    "extra_result",
    "nonfailed",
    "missing",
    "nul_id",
    "action_id",
  ])("excludes malformed upload recovery source %s", async (corruption) => {
    const f = await fixture(),
      id = await failedVersion(f, null, corruption === "nonfailed" ? "uploading" : "failed"),
      target =
        corruption === "scalar"
          ? '"synthetic"'
          : corruption === "string_array"
            ? { version_ids: JSON.stringify([id]) }
            : corruption === "duplicate_key"
              ? `{"version_ids":["${id}"],"version_ids":["${id}"]}`
              : {
                  version_ids:
                    corruption === "duplicate_ids"
                      ? [id, id]
                      : [
                          corruption === "missing"
                            ? randomUlid()
                            : corruption === "nul_id"
                              ? `${id}\u0000synthetic`
                              : id,
                        ],
                },
      ledger = await recovery(
        f,
        "resolve_stuck_upload",
        target,
        corruption === "extra_result"
          ? { resolved: 1, extra: 1 }
          : { resolved: corruption === "wrong_count" ? 2 : 1 },
      );
    if (corruption === "action_id")
      await f.db
        .prepare("UPDATE ops_recovery_ledger SET action_id=? WHERE workspace_id=? AND action_id=?")
        .run(`${ledger}\u0000synthetic`, FIX.workspace, ledger);
    expect((await read(f.db)).ops_recovery.applied).toBe(0);
  });
  it.each(["role", "epoch", "project", "privacy"])(
    "remasks all counts and work after final %s change",
    async (loss) => {
      const f = await fixture();
      await notification(f);
      await github(f);
      await evidence(f, "branch", "main");
      await failedVersion(f, f.launch.run_id, "uploading");
      const work = {
        uploads: await listStuckUploads(f.db, FIX.workspace, NOW, access()),
        launches: await listStuckLaunches(f.db, FIX.workspace, NOW, access()),
      };
      const db = beforeFinal(f.db, async () => {
        if (loss === "role") {
          await f.db
            .prepare(
              "UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND human_id=?",
            )
            .run(FIX.workspace, FIX.member);
          await f.db
            .prepare(
              "UPDATE workspace_members SET role='reviewer' WHERE workspace_id=? AND human_id=?",
            )
            .run(FIX.workspace, FIX.owner);
        } else if (loss === "epoch") await rotate(f.db);
        else if (loss === "project") await restrict(f.db);
        else await privacy(f);
      });
      if (loss === "epoch" || loss === "role")
        await expect(
          readOperationsProjection(db, FIX.workspace, NOW, work, access()),
        ).rejects.toMatchObject({ code: "not_found", message: "operations scope not found" });
      else {
        const current = await readOperationsProjection(db, FIX.workspace, NOW, work, access());
        expect(current.queues).toEqual(EMPTY);
        expect(current.work).toEqual({ uploads: [], launches: [] });
      }
    },
  );
  it("health reads new visible queue and token rows in its final statement", async () => {
    const f = await fixture(),
      db = beforeFinal(f.db, async () => {
        await notification(f);
        await f.db
          .prepare("UPDATE runner_tokens SET revoked_at=? WHERE workspace_id=?")
          .run(NOW, FIX.workspace);
      });
    const health = await collectWorkspaceHealth(db, FIX.workspace, NOW, access());
    expect(health.queues.notifications.pending).toBe(1);
    expect(health.tokens.expiring_runner_tokens).toBe(0);
  });
  it.each(["result.submit", "result.accept", "result.request_changes"])(
    "rejects missing exact submission linkage for %s",
    async (kind) => {
      const f = await fixture(),
        id = await submission(f),
        value = {
          input: { runId: f.launch.run_id, submissionId: randomUlid() },
          result: {
            taskState: "review",
            runResultState: kind === "result.accept" ? "accepted" : "changes_requested",
            submission: { id, run_id: f.launch.run_id, version: 2 },
          },
        },
        cursor = await event(f, kind, value);
      await delivery(
        f,
        cursor,
        kind,
        kind === "result.submit"
          ? "result_submitted"
          : kind === "result.accept"
            ? "result_accepted"
            : "result_changes_requested",
      );
      expect(await read(f.db)).toEqual(EMPTY);
    },
  );
  it("rejects authorize input/result launch disagreement", async () => {
    const f = await fixture(),
      cursor = await event(f, "launch.authorize", {
        input: { launchId: randomUlid() },
        result: {
          launch_id: f.launch.launch_id,
          decision: "rejected",
          rejection: { code: "launch_blocked" },
        },
      });
    await delivery(f, cursor, "launch.authorize", "launch_blocked");
    expect(await read(f.db)).toEqual(EMPTY);
  });
  it("rejects duplicate recognized nested result fields", async () => {
    const f = await fixture(),
      id = await submission(f),
      cursor = await event(
        f,
        "result.submit",
        `{"input":{},"result":{"taskState":"review","submission":{"id":"${id}","id":"${id}","run_id":"${f.launch.run_id}","version":1}}}`,
      );
    await delivery(f, cursor, "result.submit", "result_submitted");
    expect(await read(f.db)).toEqual(EMPTY);
  });
  it("omits nonproducer GitHub action spellings even when stored and effect agree", async () => {
    const f = await fixture();
    await github(f, { action: "Synthetic prose" });
    expect(await read(f.db)).toEqual(EMPTY);
  });
  it("counts token source rows including expired unrevoked tokens, not usable credentials", async () => {
    const f = await fixture(),
      current = await readOperationsProjection(
        f.db,
        FIX.workspace,
        NOW,
        { uploads: [], launches: [] },
        access(),
      );
    expect(current.tokens.expiring_runner_tokens).toBe(1);
    await f.db
      .prepare(
        "UPDATE runner_tokens SET expires_at='2026-09-15T00:00:00.000Z' WHERE workspace_id=?",
      )
      .run(FIX.workspace);
    expect(
      (
        await readOperationsProjection(
          f.db,
          FIX.workspace,
          NOW,
          { uploads: [], launches: [] },
          access(),
        )
      ).tokens.expiring_runner_tokens,
    ).toBe(0);
  });
  it("requires explicit context and denies foreign observers for projection and queue wrapper", async () => {
    const f = await fixture();
    await expect(
      readQueueState(f.db, FIX.workspace, NOW, undefined as unknown as TaskAccessContext),
    ).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(
      readOperationsProjection(
        f.db,
        FIX.workspace,
        NOW,
        { uploads: [], launches: [] },
        { ...access(), workspaceId: randomUlid() },
      ),
    ).rejects.toMatchObject({ code: "not_found", message: "operations scope not found" });
  });
  it("makes one final source selection without any later awaited read", async () => {
    const f = await fixture();
    await notification(f);
    let statements = 0;
    const db: SqlDatabase = {
      ...f.db,
      prepare(sql) {
        statements++;
        return f.db.prepare(sql);
      },
    };
    expect(
      (
        await readOperationsProjection(
          db,
          FIX.workspace,
          NOW,
          { uploads: [], launches: [] },
          access(),
        )
      ).queues.notifications.pending,
    ).toBe(1);
    expect(statements).toBe(1);
  });
  it("remasks NUL-suffixed upload run parents while retaining exact run-free and launch controls", async () => {
    const f = await fixture(),
      badRun = await malformedRun(f),
      bound = await failedVersion(f, f.launch.run_id, "uploading"),
      hidden = await failedVersion(f, badRun, "uploading"),
      free = await failedVersion(f, null, "uploading"),
      uploads = await listStuckUploads(f.db, FIX.workspace, NOW, access()),
      launches = await listStuckLaunches(f.db, FIX.workspace, NOW, access());
    expect(uploads.map((row) => row.version_id)).toContain(hidden);
    const current = await readOperationsProjection(
      f.db,
      FIX.workspace,
      NOW,
      { uploads, launches: [...launches, { ...launches[0]!, run_id: badRun }] },
      access(),
    );
    expect(new Set(current.work.uploads.map((row) => row.version_id))).toEqual(
      new Set([bound, free]),
    );
    expect(current.work.launches).toEqual(launches);
    expect(JSON.stringify(current.work)).not.toContain("synthetic");
  });
  it("remasks NUL-suffixed retention run parents without rewriting historical rows", async () => {
    const f = await fixture(),
      badRun = await malformedRun(f),
      visible = await retentionVersion(f, f.launch.run_id),
      hidden = await retentionVersion(f, badRun),
      retention = await listRetentionEligibleChunks(f.db, FIX.workspace, NOW, access());
    expect(retention.eligible.map((row) => row.version_id)).toContain(hidden);
    const current = await readOperationsProjection(
      f.db,
      FIX.workspace,
      NOW,
      { uploads: [], launches: [], retention: retention.eligible },
      access(),
    );
    expect(current.work.retention?.map((row) => row.version_id)).toEqual([visible]);
    expect(
      await f.db
        .prepare(
          "SELECT run_id FROM artifacts WHERE workspace_id=? AND id=(SELECT artifact_id FROM artifact_versions WHERE workspace_id=? AND id=?)",
        )
        .get(FIX.workspace, FIX.workspace, hidden),
    ).toEqual({ run_id: badRun });
  });
  it.each([FIX.owner, FIX.member])(
    "permits current observer %s without changing supported source counts",
    async (humanId) => {
      const f = await fixture();
      await notification(f);
      expect((await read(f.db, access(humanId))).notifications.pending).toBe(1);
    },
  );
  it.each([FIX.reviewer, randomUlid()])(
    "denies nonoperator %s even when sources are empty",
    async (humanId) => {
      const f = await fixture();
      await expect(read(f.db, access(humanId))).rejects.toMatchObject({
        code: "not_found",
        message: "operations scope not found",
      });
    },
  );
});

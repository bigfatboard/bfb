// ABOUTME: Proves action-bound offline policy permission and current authority in the real WorkspaceHub lane.
// ABOUTME: Exercises staged D1 proof consumption, policy history, cache ordering and deny-by-default migration behavior.

import { adaptD1, type D1Like, type D1StatementLike, type SqlDatabase } from "@bfb/db";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FIX } from "../src/fixtures.js";
import {
  WorkspaceHub,
  type CommandOutcome,
  type CommandRequest,
  type HubCommand,
} from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import {
  createProjectCommand,
  normalizeRepositoryConfig,
  policyUpdateTarget,
  repositoryConfigPolicyTarget,
  reportRepositoryConfigCommand,
  updateProjectPolicyCommand,
  updateWorkspacePolicyCommand,
  type PolicySettings,
  type ReportRepositoryConfigInput,
  type UpdatePolicyInput,
  type UpdateProjectPolicyInput,
} from "../src/projects.js";
import {
  deniedOfflineAgentWork,
  type OfflineAgentWorkPolicy,
} from "../src/offline-agent-policy.js";
import { consumeStepUpProof, issueStepUpProof, type StepUpAction } from "../src/step-up.js";
import { openDomainDb } from "./helpers.js";

const NOW = "2026-10-06T00:00:00.000Z",
  EXPIRY = "2026-10-06T00:10:00.000Z";
const actions = ["workspace", "project", "repository"] as const;
type Action = (typeof actions)[number];
type Input = UpdatePolicyInput | UpdateProjectPolicyInput | ReportRepositoryConfigInput;
const commands = {
  workspace: updateWorkspacePolicyCommand,
  project: updateProjectPolicyCommand,
  repository: reportRepositoryConfigCommand,
};
const heads = {
  workspace: "workspace_policies",
  project: "project_policies",
  repository: "repository_configs",
};
const histories = {
  workspace: "workspace_policy_versions",
  project: "project_policy_versions",
  repository: "repository_config_versions",
};
const permission: OfflineAgentWorkPolicy = {
  allowed_tools: ["bfb_update_task", "bfb_report_progress", "bfb_propose_task", "bfb_add_comment"],
  max_pending_age_seconds: 300,
};
function settings(offline = permission): PolicySettings {
  return {
    allowedProviders: ["claude", "codex", "grok"],
    allowAgentRootPropose: true,
    allowPassToAgent: true,
    allowRunOverrides: true,
    offlineAgentWork: offline,
    offlineAgentResults: { allow_submit_result: false, max_pending_age_seconds: 0 },
  };
}
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function success<T>(outcome: CommandOutcome<T>): T {
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
  if (!outcome.ok) throw new Error(outcome.error.code);
  return outcome.result;
}
function execute(
  db: SqlDatabase,
  action: Action,
  input: Input,
  key = randomUlid(),
  overrides: Partial<CommandRequest<Input>> = {},
  hub = new WorkspaceHub(db),
) {
  return hub.execute(commands[action] as HubCommand<Input, unknown>, {
    workspaceId: FIX.workspace,
    actorHumanId: FIX.owner,
    authorizationEpoch: 1,
    now: NOW,
    idempotencyKey: key,
    input,
    ...overrides,
  });
}
async function version(db: SqlDatabase, action: Action) {
  return (
    (await db
      .prepare(
        `SELECT resource_version FROM ${heads[action]} WHERE workspace_id = ?${action === "workspace" ? "" : " AND project_id = ?"}`,
      )
      .get(FIX.workspace, ...(action === "workspace" ? [] : [FIX.projectA]))) as {
      resource_version: number;
    }
  ).resource_version;
}
async function draft(db: SqlDatabase, action: Action, offline = permission) {
  const expectedVersion = await version(db, action),
    policy = settings(offline);
  const document = { offline_agent_work: offline },
    canonical = normalizeRepositoryConfig(document, settings()).canonical,
    contentHash = hash(canonical);
  const projectId = action === "workspace" ? undefined : FIX.projectA;
  const targetId =
    action === "repository"
      ? repositoryConfigPolicyTarget(
          FIX.workspace,
          FIX.projectA,
          expectedVersion,
          contentHash,
          normalizeRepositoryConfig(document, settings()).settings,
        )
      : policyUpdateTarget(
          FIX.workspace,
          action === "workspace" ? "workspace.policy.update" : "project.policy.update",
          projectId,
          expectedVersion,
          policy,
        );
  const proofAction: StepUpAction = {
    action: commands[action].name,
    workspaceId: FIX.workspace,
    ...(projectId ? { projectId } : {}),
    targetId,
    scopes: [],
    authorizationEpoch: 1,
    expiresAt: EXPIRY,
  };
  const input =
    action === "repository"
      ? { projectId: FIX.projectA, expectedVersion, document, contentHash }
      : { ...policy, expectedVersion, ...(projectId ? { projectId } : {}) };
  return { input: input as Input, proofAction, expectedVersion, canonical, contentHash };
}
async function authorized(db: SqlDatabase, action: Action, offline = permission) {
  const request = await draft(db, action, offline),
    stepUpProofId = await issueStepUpProof(db, FIX.owner, request.proofAction, NOW);
  return {
    ...request,
    proofId: stepUpProofId,
    input: { ...request.input, stepUpProofId } as Input,
  };
}
async function fixture(database?: SqlDatabase) {
  const db = database ?? (await openDomainDb());
  // Repository tests need actual explicitly enabled parent versions, never inferred permission.
  for (const action of ["workspace", "project"] as const)
    success(await execute(db, action, (await authorized(db, action)).input));
  return db;
}
async function state(db: SqlDatabase) {
  const result: Record<string, unknown> = {};
  for (const table of [
    "workspace_policies",
    "project_policies",
    "repository_configs",
    "workspace_policy_versions",
    "project_policy_versions",
    "repository_config_versions",
    "passkey_step_up_proofs",
    "semantic_events",
    "audit_events",
    "outbox_records",
    "idempotency_records",
    "workspace_cursors",
    "runner_mutation_guards",
  ])
    result[table] = await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return result;
}
async function proofState(db: SqlDatabase, proofId: string) {
  return (await db
    .prepare("SELECT consumed_at FROM passkey_step_up_proofs WHERE proof_id = ?")
    .get(proofId)) as { consumed_at: string | null };
}

// The shipped D1 adapter rejects read-after-write and flushes all staged statements atomically.
function stagedD1(db: SqlDatabase) {
  const statements = new Map<D1StatementLike, { sql: string; params: unknown[] }>();
  let failure: RegExp | undefined, beforeBatch: (() => Promise<void>) | undefined;
  const batches: string[][] = [];
  const binding: D1Like = {
    prepare(sql) {
      const entry = { sql, params: [] as unknown[] };
      const statement: D1StatementLike = {
        bind(...params) {
          entry.params = params;
          return statement;
        },
        first: async () => (await db.prepare(sql).get(...entry.params)) ?? null,
        all: async () => ({ results: (await db.prepare(sql).all(...entry.params)) as unknown[] }),
        run: async () => ({
          meta: (await db.prepare(sql).run(...entry.params)) as { changes: number },
        }),
      };
      statements.set(statement, entry);
      return statement;
    },
    async batch(pending) {
      const entries = pending.map((statement) => statements.get(statement)!);
      batches.push(entries.map((entry) => entry.sql));
      const callback = beforeBatch;
      beforeBatch = undefined;
      await callback?.();
      return db.withTransaction(async (tx) => {
        const results = [];
        for (const entry of entries) {
          const meta = await tx.prepare(entry.sql).run(...entry.params);
          if (failure?.test(entry.sql)) throw new Error("synthetic-private-policy-batch-failure");
          results.push({ meta: meta as { changes: number } });
        }
        return results;
      });
    },
  };
  return {
    db: adaptD1(binding),
    batches,
    fail(pattern?: RegExp) {
      failure = pattern;
    },
    before(callback: () => Promise<void>) {
      beforeBatch = callback;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => vi.useRealTimers());

describe("offline policy authority in WorkspaceHub", () => {
  it("defaults every historical head/version to deny and preserves repository canonical bytes", async () => {
    const db = await openDomainDb();
    for (const table of [...Object.values(heads), ...Object.values(histories)]) {
      const rows = await db
        .prepare(
          `SELECT offline_agent_tools_json,offline_agent_max_pending_age_seconds FROM ${table}`,
        )
        .all();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows)
        expect(row).toEqual({
          offline_agent_tools_json: "[]",
          offline_agent_max_pending_age_seconds: 0,
        });
    }
    for (const table of ["repository_configs", "repository_config_versions"])
      for (const row of await db.prepare(`SELECT canonical_json,content_hash FROM ${table}`).all())
        expect(row).toEqual({ canonical_json: "{}", content_hash: hash("{}") });
  });

  it("does not inherit enabled offline permission into a newly created project/config", async () => {
    const db = await fixture();
    const result = success(
      await new WorkspaceHub(db).execute(createProjectCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        now: NOW,
        idempotencyKey: randomUlid(),
        input: {
          name: "Synthetic offline default",
          slug: "synthetic-offline",
          tint: "#123456",
          accessMode: "restricted",
          repositoryHost: "github.com",
          hostedRepositoryId: "synthetic-offline-project",
          repositorySubpath: ".",
        },
      }),
    );
    for (const table of [
      "project_policies",
      "project_policy_versions",
      "repository_configs",
      "repository_config_versions",
    ])
      expect(
        await db
          .prepare(
            `SELECT offline_agent_tools_json,offline_agent_max_pending_age_seconds FROM ${table} WHERE project_id = ?`,
          )
          .get(result.id),
      ).toEqual({ offline_agent_tools_json: "[]", offline_agent_max_pending_age_seconds: 0 });
  });

  it.each(actions)(
    "atomically commits %s proof, normalized head and immutable version; cached retries do not consume another proof",
    async (action) => {
      const db = await fixture(),
        request = await authorized(db, action),
        key = randomUlid();
      const historyBefore = await db
        .prepare(`SELECT * FROM ${histories[action]} ORDER BY rowid`)
        .all();
      const first = await execute(db, action, request.input, key);
      success(first);
      expect((await proofState(db, request.proofId)).consumed_at).toBeTruthy();
      const expected = {
        offline_agent_tools_json: JSON.stringify([...permission.allowed_tools].sort()),
        offline_agent_max_pending_age_seconds: 300,
      };
      expect(
        await db
          .prepare(
            `SELECT offline_agent_tools_json,offline_agent_max_pending_age_seconds,resource_version FROM ${heads[action]} WHERE workspace_id = ?${action === "workspace" ? "" : " AND project_id = ?"}`,
          )
          .get(FIX.workspace, ...(action === "workspace" ? [] : [FIX.projectA])),
      ).toEqual({ ...expected, resource_version: request.expectedVersion + 1 });
      const all = (await db
        .prepare(`SELECT * FROM ${histories[action]} ORDER BY rowid`)
        .all()) as Record<string, unknown>[];
      expect(all).toHaveLength(historyBefore.length + 1);
      expect(all.slice(0, historyBefore.length)).toEqual(historyBefore);
      expect(all.at(-1)).toMatchObject({ ...expected, version: request.expectedVersion + 1 });
      const committed = await state(db),
        replay = await execute(db, action, request.input, key);
      expect(replay).toMatchObject({ ok: true, replayed: true, result: success(first) });
      expect(await state(db)).toEqual(committed);
      const secondProof = await issueStepUpProof(db, FIX.owner, request.proofAction, NOW),
        before = await state(db);
      expect(
        await execute(db, action, { ...request.input, stepUpProofId: secondProof }, key),
      ).toMatchObject({ ok: true, replayed: true, result: success(first) });
      expect(await proofState(db, secondProof)).toEqual({ consumed_at: null });
      expect(await state(db)).toEqual(before);
    },
  );

  it.each(actions)(
    "rejects changed %s fields under a committed identity without consuming its replacement proof",
    async (action) => {
      const db = await fixture(),
        request = await authorized(db, action),
        key = randomUlid();
      success(await execute(db, action, request.input, key));
      const changed = await authorized(db, action, { ...permission, max_pending_age_seconds: 299 });
      const before = await state(db);
      expect(await execute(db, action, changed.input, key)).toMatchObject({
        ok: false,
        error: { code: "request_rejected" },
      });
      expect(await state(db)).toEqual(before);
      expect(await proofState(db, changed.proofId)).toEqual({ consumed_at: null });
    },
  );

  it.each(actions)("requires a matching one-use proof for each new %s effect", async (action) => {
    const db = await fixture(),
      request = await authorized(db, action),
      before = await state(db);
    expect(
      await execute(db, action, { ...request.input, stepUpProofId: undefined } as Input),
    ).toMatchObject({ ok: false, error: { code: "step_up_invalid" } });
    expect(await state(db)).toEqual(before);
    const first = await execute(db, action, request.input);
    success(first);
    const fresh = await draft(db, action),
      committed = await state(db);
    expect(
      await execute(db, action, { ...fresh.input, stepUpProofId: request.proofId } as Input),
    ).toMatchObject({ ok: false, error: { code: "step_up_replayed" } });
    expect(await state(db)).toEqual(committed);
  });

  it.each(actions)(
    "rejects old/substituted %s step-up targets and leaves proof/head/history intact",
    async (action) => {
      const db = await fixture(),
        request = await draft(db, action);
      const legacy = hash(
        JSON.stringify([
          commands[action].name,
          action === "workspace" ? null : FIX.projectA,
          request.expectedVersion,
          [...settings().allowedProviders].sort(),
          true,
          true,
          true,
        ]),
      );
      const targets = [legacy, hash("synthetic-substituted-target")];
      for (const targetId of targets) {
        const proofId = await issueStepUpProof(
            db,
            FIX.owner,
            { ...request.proofAction, targetId },
            NOW,
          ),
          before = await state(db);
        expect(
          await execute(db, action, { ...request.input, stepUpProofId: proofId } as Input),
        ).toMatchObject({ ok: false, error: { code: "step_up_mismatch" } });
        expect(await state(db)).toEqual(before);
      }
    },
  );

  it.each(actions)(
    "rejects %s proof substitution across action, workspace, project, owner, epoch and time",
    async (action) => {
      const db = await fixture(),
        request = await draft(db, action);
      for (const changes of [
        { action: "project.access.grant" },
        { workspaceId: randomUlid() },
        { projectId: action === "workspace" ? FIX.projectA : FIX.projectB },
        { authorizationEpoch: 2 },
        { scopes: ["bfb:task:write"] },
      ]) {
        const proofId = await issueStepUpProof(
            db,
            FIX.owner,
            { ...request.proofAction, ...changes },
            NOW,
          ),
          before = await state(db);
        expect(
          await execute(db, action, { ...request.input, stepUpProofId: proofId } as Input),
        ).toMatchObject({ ok: false, error: { code: "step_up_mismatch" } });
        expect(await state(db)).toEqual(before);
      }
      const wrongHuman = await issueStepUpProof(db, FIX.member, request.proofAction, NOW),
        before = await state(db);
      expect(
        await execute(db, action, { ...request.input, stepUpProofId: wrongHuman } as Input),
      ).toMatchObject({ ok: false, error: { code: "step_up_mismatch" } });
      expect(await state(db)).toEqual(before);
      const expired = await authorized(db, action);
      await db
        .prepare("UPDATE passkey_step_up_proofs SET expires_at = ? WHERE proof_id = ?")
        .run(NOW, expired.proofId);
      const expiredBefore = await state(db);
      expect(await execute(db, action, expired.input)).toMatchObject({
        ok: false,
        error: { code: "step_up_stale" },
      });
      expect(await state(db)).toEqual(expiredBefore);
    },
  );

  it.each(actions)(
    "binds a fresh %s effect to the exact signed new permission fields",
    async (action) => {
      const db = await fixture(),
        request = await authorized(db, action);
      const altered = await draft(db, action, { ...permission, max_pending_age_seconds: 299 });
      const before = await state(db);
      expect(
        await execute(db, action, { ...altered.input, stepUpProofId: request.proofId } as Input),
      ).toMatchObject({ ok: false, error: { code: "step_up_mismatch" } });
      expect(await state(db)).toEqual(before);
      expect(await proofState(db, request.proofId)).toEqual({ consumed_at: null });
    },
  );

  it.each(actions)(
    "rechecks current direct-human owner authority before cached %s results",
    async (action) => {
      for (const mode of ["role", "epoch", ...(action === "workspace" ? [] : ["project grant"])]) {
        const db = await fixture(),
          request = await authorized(db, action),
          key = randomUlid();
        await db
          .prepare(
            "UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ? AND human_id = ?",
          )
          .run(FIX.workspace, FIX.member);
        success(await execute(db, action, request.input, key));
        if (mode === "role")
          await db
            .prepare(
              "UPDATE workspace_members SET role = 'member' WHERE workspace_id = ? AND human_id = ?",
            )
            .run(FIX.workspace, FIX.owner);
        else if (mode === "epoch") {
          await db
            .prepare(
              "UPDATE workspace_members SET authorization_epoch = 2 WHERE workspace_id = ? AND human_id = ?",
            )
            .run(FIX.workspace, FIX.owner);
          await db
            .prepare(
              "UPDATE workspace_authorization_epochs SET authorization_epoch = 2 WHERE workspace_id = ? AND human_id = ?",
            )
            .run(FIX.workspace, FIX.owner);
        } else
          await db
            .prepare(
              "DELETE FROM project_access WHERE workspace_id = ? AND project_id = ? AND human_id = ?",
            )
            .run(FIX.workspace, FIX.projectA, FIX.owner);
        const before = await state(db);
        for (const requestId of [key, randomUlid()])
          expect(await execute(db, action, request.input, requestId)).toMatchObject({
            ok: false,
            error: { code: mode === "epoch" ? "stale_authorization" : "forbidden" },
          });
        expect(await state(db)).toEqual(before);
      }
    },
  );

  it.each(actions)(
    "does not accept delegated/runner/system authority for %s, including cached results",
    async (action) => {
      const db = await fixture(),
        request = await authorized(db, action),
        key = randomUlid();
      success(await execute(db, action, request.input, key));
      const before = await state(db);
      for (const overrides of [
        { actorDelegationId: randomUlid() },
        { actorHumanId: undefined, actorRunnerId: randomUlid() },
        { actorHumanId: undefined, actorSystemId: randomUlid() },
      ]) {
        for (const requestId of [key, randomUlid()])
          expect(await execute(db, action, request.input, requestId, overrides)).toMatchObject({
            ok: false,
            error: { code: "forbidden" },
          });
      }
      expect(await state(db)).toEqual(before);
    },
  );

  it.each(["workspace", "project"] as const)(
    "rejects missing or invalid complete %s offline settings before consuming proof",
    async (action) => {
      const db = await fixture(),
        request = await authorized(db, action);
      for (const offlineAgentWork of [
        undefined,
        null,
        {},
        { allowed_tools: ["bfb_submit_result"], max_pending_age_seconds: 60 },
        { allowed_tools: [], max_pending_age_seconds: 1 },
        { allowed_tools: ["bfb_add_comment"], max_pending_age_seconds: 301 },
        { allowed_tools: ["bfb_add_comment"], max_pending_age_seconds: 1.5 },
      ]) {
        const before = await state(db);
        expect(
          await execute(db, action, { ...request.input, offlineAgentWork } as Input),
        ).toMatchObject({ ok: false, error: { code: "invalid_policy" } });
        expect(await state(db)).toEqual(before);
      }
    },
  );

  it("requires proof even for explicit repository denial but omission preserves empty bytes and never inherits enabled parents", async () => {
    const db = await fixture(),
      denied = await draft(db, "repository", deniedOfflineAgentWork()),
      before = await state(db);
    expect(await execute(db, "repository", denied.input)).toMatchObject({
      ok: false,
      error: { code: "step_up_invalid" },
    });
    expect(await state(db)).toEqual(before);
    success(
      await execute(db, "repository", {
        projectId: FIX.projectA,
        expectedVersion: await version(db, "repository"),
        document: {},
        contentHash: hash("{}"),
      }),
    );
    expect(
      await db
        .prepare(
          "SELECT canonical_json,content_hash,offline_agent_tools_json,offline_agent_max_pending_age_seconds FROM repository_configs WHERE project_id = ?",
        )
        .get(FIX.projectA),
    ).toEqual({
      canonical_json: "{}",
      content_hash: hash("{}"),
      offline_agent_tools_json: "[]",
      offline_agent_max_pending_age_seconds: 0,
    });
    const explicit = await authorized(db, "repository", deniedOfflineAgentWork());
    success(await execute(db, "repository", explicit.input));
    expect((await proofState(db, explicit.proofId)).consumed_at).toBeTruthy();
  });

  it.each(["project", "repository"] as const)(
    "rejects %s widening tools or lifetime without consuming its proof",
    async (action) => {
      const db = await fixture();
      const parentAction = action === "project" ? "workspace" : "project";
      success(
        await execute(
          db,
          parentAction,
          (
            await authorized(db, parentAction, {
              allowed_tools: ["bfb_add_comment"],
              max_pending_age_seconds: 30,
            })
          ).input,
        ),
      );
      for (const offline of [
        { allowed_tools: ["bfb_add_comment", "bfb_update_task"], max_pending_age_seconds: 30 },
        { allowed_tools: ["bfb_add_comment"], max_pending_age_seconds: 31 },
      ] as OfflineAgentWorkPolicy[]) {
        // Targets remain well-formed even when the requested effect exceeds its current ceiling.
        const request = await authorized(db, action, offline),
          before = await state(db);
        expect(await execute(db, action, request.input)).toMatchObject({
          ok: false,
          error: { code: "policy_widening" },
        });
        expect(await state(db)).toEqual(before);
      }
    },
  );

  it.each(
    actions.flatMap((action) => ["history", "outcome"].map((failure) => ({ action, failure }))),
  )(
    "rolls back $action proof/head/history/receipts after late $failure batch failure",
    async ({ action, failure }) => {
      const raw = await fixture(),
        staged = stagedD1(raw),
        request = await authorized(raw, action),
        before = await state(raw);
      staged.fail(
        new RegExp(
          `INSERT INTO ${failure === "history" ? histories[action] : "idempotency_records"}`,
          "u",
        ),
      );
      expect(await execute(staged.db, action, request.input)).toMatchObject({
        ok: false,
        error: { code: "command_failed" },
      });
      expect(await state(raw)).toEqual(before);
      expect(await proofState(raw, request.proofId)).toEqual({ consumed_at: null });
      staged.fail();
      success(await execute(staged.db, action, request.input));
      const batch = staged.batches.at(-1)!;
      expect(batch.some((sql) => sql.includes("UPDATE passkey_step_up_proofs"))).toBe(true);
      expect(batch.some((sql) => sql.includes(`UPDATE ${heads[action]}`))).toBe(true);
      expect(batch.some((sql) => sql.includes(`INSERT INTO ${histories[action]}`))).toBe(true);
      expect(batch.some((sql) => sql.includes("INSERT INTO idempotency_records"))).toBe(true);
      expect(
        await raw.prepare("SELECT COUNT(*) AS count FROM runner_mutation_guards").get(),
      ).toEqual({ count: 0 });
    },
  );

  it("aborts staged policy writes when another consumer wins its one-use proof", async () => {
    const raw = await fixture(),
      staged = stagedD1(raw),
      request = await authorized(raw, "workspace");
    let otherWinner: Record<string, unknown> | undefined;
    staged.before(async () => {
      await consumeStepUpProof(raw, request.proofId, request.proofAction, NOW, FIX.owner);
      otherWinner = await state(raw);
    });
    expect(await execute(staged.db, "workspace", request.input)).toMatchObject({
      ok: false,
      error: { code: "command_failed" },
    });
    expect(otherWinner).toBeDefined();
    expect(await state(raw)).toEqual(otherWinner);
  });

  it("aborts the entire losing batch when another actual Hub command advances the policy head", async () => {
    const raw = await fixture(),
      staged = stagedD1(raw),
      losing = await authorized(raw, "workspace"),
      winning = await authorized(raw, "workspace", { ...permission, max_pending_age_seconds: 299 });
    let otherWinner: Record<string, unknown> | undefined;
    staged.before(async () => {
      success(await execute(raw, "workspace", winning.input));
      otherWinner = await state(raw);
    });
    expect(await execute(staged.db, "workspace", losing.input)).toMatchObject({
      ok: false,
      error: { code: "command_failed" },
    });
    expect(otherWinner).toBeDefined();
    expect(await state(raw)).toEqual(otherWinner);
    expect(await proofState(raw, losing.proofId)).toEqual({ consumed_at: null });
  });
});

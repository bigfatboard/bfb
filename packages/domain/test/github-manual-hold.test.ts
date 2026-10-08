// ABOUTME: Proves beta manual GitHub evidence linking is unavailable before source and cache lookup.
// ABOUTME: Synthetic historical associations and receipts retain full canonical state across admitted attempts.

import { createHash } from "node:crypto";
import type { SqlDatabase } from "@bfb/db";
import { describe, expect, it } from "vitest";

import { bumpMemberEpoch } from "../src/authorization.js";
import { FIX } from "../src/fixtures.js";
import {
  linkGitHubEvidenceCommand,
  type GitHubEvidenceRecord,
  type LinkGitHubEvidenceInput,
} from "../src/github.js";
import { WorkspaceHub, type CommandRequest } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { canonicalLaunchJson } from "../src/launch-state.js";
import { createTaskCommand } from "../src/work-commands.js";
import { openDomainDb } from "./helpers.js";
import { success } from "./launch-fixture.js";

const HISTORY = "2026-09-18T12:00:00.000Z";
const REPOSITORY = "1234";
const HOLD = {
  ok: false,
  error: {
    code: "request_rejected",
    message: "manual GitHub evidence linking is unavailable",
  },
};
const KEY_STATES = ["absent", "project_only", "shared", "private", "other_project"] as const;
const ENGINE_TABLES = new Set(["sqlite_sequence", "d1_migrations", "_cf_METADATA"]);
type KeyState = (typeof KEY_STATES)[number];
type Observer = "human" | "runner";
type Row = Record<string, unknown>;
type Snapshot = { canonical: Record<string, Row[]>; budgets: Row[]; excluded: string[] };

async function snapshot(db: SqlDatabase): Promise<Snapshot> {
  const tables = (await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  const canonical: Record<string, Row[]> = {};
  const excluded: string[] = [];
  for (const { name } of tables) {
    if (ENGINE_TABLES.has(name)) {
      excluded.push(name);
      continue;
    }
    if (name.startsWith("sqlite_") || name.startsWith("_cf_"))
      throw new Error(`unexpected snapshot engine table: ${name}`);
    expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/u);
    if (name !== "rate_limit_buckets")
      canonical[name] = (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()) as Row[];
  }
  // This domain proof has no HTTP budget effects, but does not silently omit them.
  const budgets = (await db
    .prepare("SELECT * FROM rate_limit_buckets ORDER BY rowid")
    .all()) as Row[];
  return { canonical, budgets, excluded };
}

function observedDatabase(db: SqlDatabase) {
  const touches = { task: 0, evidence: 0, cache: 0, authority: 0 };
  function wrap(database: SqlDatabase): SqlDatabase {
    return {
      prepare(sql) {
        const statement = database.prepare(sql);
        const observe = () => {
          if (/\b(?:tasks|task_privacy|task_human_grants)\b/iu.test(sql)) touches.task++;
          if (/\bgithub_evidence\b/iu.test(sql)) touches.evidence++;
          if (/\bidempotency_records\b/iu.test(sql)) touches.cache++;
          if (
            /\b(?:workspace_members|workspace_authorization_epochs|projects|project_access)\b/iu.test(
              sql,
            )
          )
            touches.authority++;
        };
        return {
          get(...parameters) {
            observe();
            return statement.get(...parameters);
          },
          all(...parameters) {
            observe();
            return statement.all(...parameters);
          },
          run(...parameters) {
            observe();
            return statement.run(...parameters);
          },
        };
      },
      // Hub uses the transaction handle, not the outer prepare method.
      withTransaction: (fn) => database.withTransaction((tx) => fn(wrap(tx))),
    };
  }
  return { db: wrap(db), touches };
}

async function fixture() {
  const db = await openDomainDb();
  const hub = new WorkspaceHub(db);
  const create = async (projectId: string) =>
    success(
      await hub.execute(createTaskCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.member,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        input: { projectId, title: "Synthetic manual GitHub parent", priority: "P2" },
      }),
    );
  const shared = await create(FIX.projectA);
  const privateTask = await create(FIX.projectA);
  const otherProject = await create(FIX.projectB);
  // Dormant private policy belongs to the genuine creator. No private creation
  // is enabled, and the named Owner making the attempted link receives no grant.
  await db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, privateTask.id, FIX.member, HISTORY);
  return { db, shared, privateTask, otherProject };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function inputFor(observer: Observer, taskId?: string): LinkGitHubEvidenceInput {
  return {
    projectId: FIX.projectA,
    ...(taskId === undefined ? {} : { taskId }),
    repositoryId: REPOSITORY,
    kind: "commit",
    ref: "synthetic-manual-key",
    versionToken: "synthetic-request-version",
    state: { summary: "SYNTHETIC_MANUAL_GITHUB_HISTORICAL_BODY" },
    observedBy: observer,
  };
}

async function seedEvidence(f: Fixture, state: KeyState, input: LinkGitHubEvidenceInput) {
  const record: GitHubEvidenceRecord = {
    id: randomUlid(),
    workspace_id: FIX.workspace,
    project_id: state === "other_project" ? FIX.projectB : FIX.projectA,
    task_id:
      state === "shared"
        ? f.shared.id
        : state === "private"
          ? f.privateTask.id
          : state === "other_project"
            ? f.otherProject.id
            : null,
    repository_id: REPOSITORY,
    kind: input.kind,
    ref: input.ref,
    version_token: input.versionToken,
    state: { summary: "SYNTHETIC_MANUAL_GITHUB_HISTORICAL_BODY" },
    observed_by: input.observedBy,
    observed_at: HISTORY,
    resource_version: 3,
  };
  if (state !== "absent")
    await f.db
      .prepare(
        `INSERT INTO github_evidence
         (workspace_id,id,project_id,task_id,repository_id,kind,ref,version_token,
          state_json,observed_by,observed_at,resource_version)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.workspace_id,
        record.id,
        record.project_id,
        record.task_id,
        record.repository_id,
        record.kind,
        record.ref,
        record.version_token,
        JSON.stringify(record.state),
        record.observed_by,
        record.observed_at,
        record.resource_version,
      );
  return record;
}

async function seedHistoricalCache(
  f: Fixture,
  input: LinkGitHubEvidenceInput,
  key: string,
  record: GitHubEvidenceRecord,
) {
  // Explicit synthetic history, never produced by the now-held command. The
  // absent/differently associated cases are retained-cache oracle controls,
  // not assertions that a source rebinding is a reachable business transition.
  const result = {
    ...record,
    project_id: input.projectId,
    task_id: input.taskId ?? null,
  };
  const cursorRow = (await f.db
    .prepare("SELECT cursor FROM workspace_cursors WHERE workspace_id=?")
    .get(FIX.workspace)) as { cursor: number };
  const cursor = cursorRow.cursor + 1;
  const fingerprint = createHash("sha256")
    .update(canonicalLaunchJson(JSON.parse(JSON.stringify(input))))
    .digest("hex");
  const payload = JSON.stringify({
    actor: { humanId: FIX.owner, authorizationEpoch: 1 },
    input: {
      projectId: input.projectId,
      taskId: input.taskId,
      repositoryId: input.repositoryId,
      kind: input.kind,
    },
    result: {
      id: result.id,
      project_id: result.project_id,
      task_id: result.task_id,
      repository_id: result.repository_id,
      kind: result.kind,
      observed_by: result.observed_by,
      resource_version: result.resource_version,
    },
  });
  await f.db.withTransaction(async (tx) => {
    await tx
      .prepare("UPDATE workspace_cursors SET cursor=? WHERE workspace_id=?")
      .run(cursor, FIX.workspace);
    await tx
      .prepare(
        `INSERT INTO idempotency_records
         (workspace_id,idempotency_key,command_name,result_json,created_at) VALUES (?,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        key,
        linkGitHubEvidenceCommand.name,
        JSON.stringify({
          result,
          cursor,
          actorHumanId: FIX.owner,
          authorizationEpoch: 1,
          inputFingerprint: fingerprint,
        }),
        HISTORY,
      );
    await tx
      .prepare(
        `INSERT INTO semantic_events
         (workspace_id,event_id,workspace_cursor,kind,payload_json,created_at) VALUES (?,?,?,?,?,?)`,
      )
      .run(FIX.workspace, randomUlid(), cursor, linkGitHubEvidenceCommand.name, payload, HISTORY);
    await tx
      .prepare(
        `INSERT INTO audit_events
         (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at) VALUES (?,?,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        randomUlid(),
        FIX.owner,
        linkGitHubEvidenceCommand.name,
        payload,
        HISTORY,
      );
    await tx
      .prepare(
        `INSERT INTO outbox_records
         (workspace_id,outbox_id,kind,payload_json,created_at,delivered_at) VALUES (?,?,?,?,?,NULL)`,
      )
      .run(FIX.workspace, randomUlid(), linkGitHubEvidenceCommand.name, payload, HISTORY);
  });
}

async function expectHeld(f: Fixture, input: LinkGitHubEvidenceInput, key: string, label: string) {
  const before = await snapshot(f.db);
  expect(await f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  const observed = observedDatabase(f.db);
  const outcome = await new WorkspaceHub(observed.db).execute(linkGitHubEvidenceCommand, {
    workspaceId: FIX.workspace,
    actorHumanId: FIX.owner,
    authorizationEpoch: 1,
    idempotencyKey: key,
    input,
  });
  // On OLD, soft assertions retain both an unauthorized success/body effect and
  // the differing not_found oracle instead of stopping at the first mismatch.
  expect.soft(outcome, label).toEqual(HOLD);
  expect.soft(await snapshot(f.db), `${label}: complete canonical no-effects`).toEqual(before);
  expect.soft(observed.touches.task, `${label}: no task lookup`).toBe(0);
  expect.soft(observed.touches.evidence, `${label}: no evidence lookup`).toBe(0);
  expect.soft(observed.touches.cache, `${label}: no Hub cache lookup`).toBe(0);
  expect(
    observed.touches.authority,
    `${label}: current membership/project admission`,
  ).toBeGreaterThan(0);
  expect(await f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

describe("beta manual GitHub evidence linking hold", () => {
  for (const cached of [false, true]) {
    for (const state of KEY_STATES) {
      it(`holds ${cached ? "exact historical cached" : "fresh"} ${state} keys for human and runner observations`, async () => {
        for (const observer of ["human", "runner"] as const) {
          // Fresh fixtures isolate each admitted attempt, including OLD writes.
          const variants =
            state === "absent" || state === "private" ? ["omitted", "explicit"] : ["explicit"];
          for (const variant of variants) {
            const f = await fixture();
            const taskId =
              state === "shared"
                ? f.shared.id
                : state === "private" && variant === "explicit"
                  ? f.privateTask.id
                  : state === "absent" && variant === "explicit"
                    ? randomUlid()
                    : undefined;
            const input = inputFor(observer, taskId);
            const record = await seedEvidence(f, state, input);
            const key = randomUlid();
            if (cached) await seedHistoricalCache(f, input, key, record);
            await expectHeld(f, input, key, `${state}/${observer}/${variant}`);
          }
        }
      });
    }
  }

  it("retains malformed closed-shape, identifiers and evidence bounds admission", async () => {
    const malformed = [
      { extra: true },
      { taskId: "not-a-task-id" },
      { repositoryId: "not-numeric" },
      { kind: "unsupported" },
      { observedBy: "github" },
      { ref: "synthetic\ncontrol" },
      { state: { summary: 17 } },
      { state: { a: "a".repeat(512), b: "b".repeat(512), c: "c".repeat(512), d: "d".repeat(512) } },
    ];
    for (const change of malformed) {
      const f = await fixture();
      const before = await snapshot(f.db);
      const outcome = await new WorkspaceHub(f.db).execute(linkGitHubEvidenceCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        input: { ...inputFor("human"), ...change } as LinkGitHubEvidenceInput,
      });
      expect(outcome).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
      expect(await snapshot(f.db)).toEqual(before);
      expect(await f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    }
  });

  it("retains Reviewer and delegated-actor rejection before source or cache lookup", async () => {
    for (const authority of [
      { actorHumanId: FIX.reviewer },
      { actorHumanId: FIX.owner, actorDelegationId: randomUlid() },
    ]) {
      const f = await fixture();
      const before = await snapshot(f.db);
      const observed = observedDatabase(f.db);
      const outcome = await new WorkspaceHub(observed.db).execute(linkGitHubEvidenceCommand, {
        workspaceId: FIX.workspace,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        ...authority,
        input: inputFor("human"),
      });
      expect(outcome).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await snapshot(f.db)).toEqual(before);
      expect({
        task: observed.touches.task,
        evidence: observed.touches.evidence,
        cache: observed.touches.cache,
      }).toEqual({ task: 0, evidence: 0, cache: 0 });
      expect(await f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    }
  });

  it("retains the captured epoch mismatch before source or cache lookup", async () => {
    const f = await fixture();
    expect(await bumpMemberEpoch(f.db, FIX.workspace, FIX.owner)).toBe(2);
    const before = await snapshot(f.db);
    const observed = observedDatabase(f.db);
    const outcome = await new WorkspaceHub(observed.db).execute(linkGitHubEvidenceCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input: inputFor("human"),
    });
    expect(outcome).toMatchObject({ ok: false, error: { code: "stale_authorization" } });
    expect(await snapshot(f.db)).toEqual(before);
    expect({
      task: observed.touches.task,
      evidence: observed.touches.evidence,
      cache: observed.touches.cache,
    }).toEqual({ task: 0, evidence: 0, cache: 0 });
    expect(await f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("retains project admission without consulting task or evidence presence", async () => {
    const f = await fixture();
    await f.db
      .prepare("UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id=?")
      .run(FIX.workspace, FIX.projectA);
    await f.db
      .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
      .run(FIX.workspace, FIX.projectA, FIX.owner);
    const before = await snapshot(f.db);
    const observed = observedDatabase(f.db);
    const request: CommandRequest<LinkGitHubEvidenceInput> = {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input: inputFor("runner", f.privateTask.id),
    };
    const outcome = await new WorkspaceHub(observed.db).execute(linkGitHubEvidenceCommand, request);
    expect(outcome).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await snapshot(f.db)).toEqual(before);
    expect({
      task: observed.touches.task,
      evidence: observed.touches.evidence,
      cache: observed.touches.cache,
    }).toEqual({ task: 0, evidence: 0, cache: 0 });
    expect(await f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

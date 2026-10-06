// ABOUTME: Proves shared-only GitHub evidence delivery, retained lineage and current recipient authority.
// ABOUTME: Synthetic historical policies exercise cache and commit fences without enabling private creation.

import { adaptD1, type D1Like, type D1StatementLike, type SqlDatabase } from "@bfb/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIX } from "../src/fixtures.js";
import {
  getEvidenceVerificationStatus,
  linkGitHubEvidenceCommand,
  listGitHubEvidence,
  type LinkGitHubEvidenceInput,
} from "../src/github.js";
import { WorkspaceHub } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { createTaskCommand } from "../src/work-commands.js";
import { openDomainDb } from "./helpers.js";
import { success } from "./launch-fixture.js";

const NOW = "2026-10-06T12:00:00.000Z";
const CANARY = "SYNTHETIC_GITHUB_REFERENCE_PROSE";
const access = (humanId = FIX.owner, authorizationEpoch = 1) => ({
  workspaceId: FIX.workspace,
  humanId,
  authorizationEpoch,
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function privacy(db: SqlDatabase, taskId: string) {
  await db
    .prepare(
      "INSERT INTO task_privacy (workspace_id, task_id, owner_human_id, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(FIX.workspace, taskId, FIX.member, NOW);
}
async function fixture() {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db);
  const task = success(
    await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.member,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input: { projectId: FIX.projectA, title: "Synthetic GitHub task", priority: "P2" },
    }),
  );
  const input = {
    projectId: FIX.projectA,
    taskId: task.id,
    repositoryId: "1234",
    kind: "commit" as const,
    ref: CANARY,
    versionToken: "SYNTHETIC_GITHUB_VERSION_PROSE",
    state: { summary: "SYNTHETIC_GITHUB_STATE_PROSE" },
    observedBy: "runner" as const,
  };
  const execute = (
    value: LinkGitHubEvidenceInput = input,
    key = randomUlid(),
    humanId = FIX.member,
  ) =>
    hub.execute(linkGitHubEvidenceCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: humanId,
      authorizationEpoch: 1,
      idempotencyKey: key,
      input: value,
    });
  return { db, hub, task, input, execute };
}

/** Executes the production D1 staged adapter with null first() and atomic batch-time races. */
function stagedD1(db: SqlDatabase, beforeBatch?: () => Promise<void>) {
  const entries = new Map<D1StatementLike, { sql: string; parameters: unknown[] }>();
  const binding: D1Like = {
    prepare(sql) {
      const entry = { sql, parameters: [] as unknown[] };
      const statement: D1StatementLike = {
        bind(...parameters) {
          expect(parameters.length).toBeLessThanOrEqual(100);
          entry.parameters = parameters;
          return statement;
        },
        first: async () => (await db.prepare(sql).get(...entry.parameters)) ?? null,
        all: async () => ({
          results: (await db.prepare(sql).all(...entry.parameters)) as unknown[],
        }),
        run: async () => ({
          meta: (await db.prepare(sql).run(...entry.parameters)) as { changes: number },
        }),
      };
      entries.set(statement, entry);
      return statement;
    },
    async batch(statements) {
      await beforeBatch?.();
      return db.withTransaction(async (tx) => {
        const results = [];
        for (const statement of statements) {
          const entry = entries.get(statement)!;
          results.push({
            meta: (await tx.prepare(entry.sql).run(...entry.parameters)) as { changes: number },
          });
        }
        return results;
      });
    },
  };
  return adaptD1(binding);
}
function before(db: SqlDatabase, match: RegExp, change: () => Promise<void>): SqlDatabase {
  let fired = false;
  return {
    ...db,
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!match.test(sql)) return statement;
      const invoke = async () => {
        if (!fired) {
          fired = true;
          await change();
        }
      };
      return {
        ...statement,
        async get(...params) {
          await invoke();
          return statement.get(...params);
        },
        async all(...params) {
          await invoke();
          return statement.all(...params);
        },
        async run(...params) {
          await invoke();
          return statement.run(...params);
        },
      };
    },
    withTransaction: (fn) =>
      db.withTransaction((tx) =>
        fn(
          before(tx, match, async () => {
            if (!fired) {
              fired = true;
              await change();
            }
          }),
        ),
      ),
  };
}

describe("private GitHub evidence fences", () => {
  it("maps the maximum mixed/duplicate reference list in one bounded D1 selection", async () => {
    const f = await fixture();
    success(await f.execute());
    await f.db
      .prepare(
        `INSERT INTO github_evidence
      (workspace_id,id,project_id,task_id,repository_id,kind,ref,version_token,state_json,observed_by,observed_at,resource_version)
      VALUES (?,?,?,NULL,'1234','commit',?,'github-version','{}','github',?,1)`,
      )
      .run(FIX.workspace, randomUlid(), FIX.projectA, CANARY, NOW);
    const refs = Array.from({ length: 20 }, (_, index) =>
      index % 4 === 0
        ? { kind: "github", ref: `github:1234:commit:${CANARY}`, version: "github-version" }
        : index % 4 === 1
          ? { kind: "github", ref: `github:1234:commit:${CANARY}`, version: "other-version" }
          : index % 4 === 2
            ? { kind: "github", ref: "malformed-reference" }
            : { kind: "artifact_version", ref: "opaque-reference" },
    );
    let selections = 0;
    const staged = stagedD1(f.db);
    const db: SqlDatabase = {
      ...staged,
      prepare(sql) {
        const statement = staged.prepare(sql);
        if (!/FROM github_evidence/.test(sql)) return statement;
        return {
          ...statement,
          async all(...parameters) {
            selections++;
            return statement.all(...parameters);
          },
        };
      },
    };
    expect(
      await getEvidenceVerificationStatus(
        db,
        FIX.workspace,
        refs,
        { projectId: FIX.projectA },
        access(),
      ),
    ).toEqual(
      refs.map((ref, index) => ({
        kind: ref.kind,
        ref: ref.ref,
        provenance: ["github_verified", "runner_observed", "unverified", "opaque"][index % 4],
      })),
    );
    expect(selections).toBe(1);
  });
  it.each(["parent", "epoch", "project"])(
    "does not compose first-ref provenance across a later %s revoke",
    async (mode) => {
      const f = await fixture(),
        second = "composition-second";
      for (const [ref, taskId] of [
        [CANARY, f.task.id],
        [second, null],
      ] as const) {
        await f.db
          .prepare(
            `INSERT INTO github_evidence
          (workspace_id,id,project_id,task_id,repository_id,kind,ref,version_token,state_json,observed_by,observed_at,resource_version)
          VALUES (?,?,?,?,'1234','commit',?,'synthetic-composition-version','{}','github',?,1)`,
          )
          .run(FIX.workspace, randomUlid(), FIX.projectA, taskId, ref, NOW);
      }
      const refs = [CANARY, second].map((ref) => ({
        kind: "github",
        ref: `github:1234:commit:${ref}`,
        version: "synthetic-composition-version",
      }));
      expect(
        (await getEvidenceVerificationStatus(f.db, FIX.workspace, refs, {}, access())).map(
          (row) => row.provenance,
        ),
      ).toEqual(["github_verified", "github_verified"]);
      let changed = false,
        reads = 0;
      const db: SqlDatabase = {
        ...f.db,
        prepare(sql) {
          const statement = f.db.prepare(sql);
          if (!/FROM github_evidence/.test(sql)) return statement;
          return {
            ...statement,
            async all(...parameters) {
              reads++;
              // The former per-ref second lookup and the new all-ref JSON binding share this boundary.
              if (
                !changed &&
                parameters.some((value) => typeof value === "string" && value.includes(second))
              ) {
                changed = true;
                if (mode === "parent") await privacy(f.db, f.task.id);
                else if (mode === "epoch") {
                  await f.db
                    .prepare(
                      "UPDATE workspace_authorization_epochs SET authorization_epoch = 2 WHERE human_id = ?",
                    )
                    .run(FIX.owner);
                  await f.db
                    .prepare(
                      "UPDATE workspace_members SET authorization_epoch = 2 WHERE human_id = ?",
                    )
                    .run(FIX.owner);
                } else {
                  await f.db
                    .prepare("UPDATE projects SET access_mode = 'restricted' WHERE id = ?")
                    .run(FIX.projectA);
                  await f.db
                    .prepare("DELETE FROM project_access WHERE project_id = ? AND human_id = ?")
                    .run(FIX.projectA, FIX.owner);
                }
              }
              return statement.all(...parameters);
            },
          };
        },
      };
      expect(
        (await getEvidenceVerificationStatus(db, FIX.workspace, refs, {}, access())).map(
          (row) => row.provenance,
        ),
      ).toEqual(
        mode === "parent" ? ["unverified", "github_verified"] : ["unverified", "unverified"],
      );
      expect(changed).toBe(true);
      expect(reads).toBe(1);
    },
  );
  it.each([FIX.member, FIX.owner])(
    "rejects private association even for creator/owner %s like missing",
    async (humanId) => {
      const f = await fixture();
      await privacy(f.db, f.task.id);
      const hidden = await f.execute(f.input, randomUlid(), humanId);
      const missing = await f.execute({ ...f.input, taskId: randomUlid() }, randomUlid(), humanId);
      expect(hidden).toMatchObject({
        ok: false,
        error: { code: "not_found", message: "task not found" },
      });
      expect(hidden).toEqual(missing);
      expect(await f.db.prepare("SELECT id FROM github_evidence").all()).toEqual([]);
    },
  );
  it("filters historical private evidence before limit and excludes it from provenance", async () => {
    const f = await fixture();
    const publicRow = success(
      await f.execute({ ...f.input, taskId: undefined, ref: "public-ref" }),
    );
    success(await f.execute());
    await privacy(f.db, f.task.id);
    await f.db
      .prepare("UPDATE github_evidence SET observed_at = ? WHERE task_id IS NOT NULL")
      .run("2026-10-06T13:00:00.000Z");
    expect(await listGitHubEvidence(f.db, FIX.workspace, { limit: 1 })).toEqual([publicRow]);
    expect(
      await getEvidenceVerificationStatus(f.db, FIX.workspace, [
        { kind: "github", ref: `github:1234:commit:${CANARY}` },
        { kind: "github", ref: "github:1234:commit:unknown-ref" },
      ]),
    ).toEqual([
      { kind: "github", ref: `github:1234:commit:${CANARY}`, provenance: "unverified" },
      { kind: "github", ref: "github:1234:commit:unknown-ref", provenance: "unverified" },
    ]);
  });
  it("retains accessible independent observations of the same external reference", async () => {
    const f = await fixture();
    success(await f.execute());
    await privacy(f.db, f.task.id);
    await f.db
      .prepare(
        `INSERT INTO github_evidence
      (workspace_id,id,project_id,task_id,repository_id,kind,ref,version_token,state_json,observed_by,observed_at,resource_version)
      VALUES (?,?,?,NULL,'1234','commit',?,'public-version','{}','github',?,1)`,
      )
      .run(FIX.workspace, randomUlid(), FIX.projectA, CANARY, NOW);
    expect(
      await getEvidenceVerificationStatus(f.db, FIX.workspace, [
        { kind: "github", ref: `github:1234:commit:${CANARY}`, version: "public-version" },
      ]),
    ).toEqual([
      { kind: "github", ref: `github:1234:commit:${CANARY}`, provenance: "github_verified" },
    ]);
  });
  it("checks retained prior task when omitted and does not detach history", async () => {
    const f = await fixture(),
      row = success(await f.execute());
    await privacy(f.db, f.task.id);
    expect(
      await f.execute({ ...f.input, taskId: undefined, versionToken: "changed" }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await f.db
        .prepare(
          "SELECT task_id, resource_version, version_token FROM github_evidence WHERE id = ?",
        )
        .get(row.id),
    ).toEqual({ task_id: f.task.id, resource_version: 1, version_token: f.input.versionToken });
  });
  it("rechecks retained task on cached project-only reply", async () => {
    const f = await fixture(),
      key = randomUlid(),
      unbound = { ...f.input, taskId: undefined };
    success(await f.execute(unbound, key));
    success(await f.execute());
    await privacy(f.db, f.task.id);
    expect(await f.execute(unbound, key)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
  it("binds retry input exactly and leaves receipts metadata-only", async () => {
    const f = await fixture(),
      key = randomUlid();
    success(await f.execute(f.input, key));
    expect(await f.execute({ ...f.input, state: { summary: "changed" } }, key)).toMatchObject({
      ok: false,
      error: { code: "request_rejected" },
    });
    const receipts = JSON.stringify(
      await f.db
        .prepare("SELECT payload_json FROM semantic_events WHERE kind = 'github.evidence.link'")
        .all(),
    );
    expect(receipts).not.toContain(CANARY);
    expect(receipts).not.toContain(f.input.versionToken);
    expect(receipts).not.toContain(f.input.state.summary);
    expect(
      JSON.stringify(
        await f.db
          .prepare("SELECT payload_json FROM audit_events WHERE action = 'github.evidence.link'")
          .all(),
      ),
    ).not.toContain(CANARY);
  });
  it.each(["list", "verification"])(
    "checks current recipient epoch in %s selection",
    async (mode) => {
      const f = await fixture();
      success(await f.execute());
      const db = before(f.db, /FROM github_evidence/, async () => {
        await f.db
          .prepare(
            "UPDATE workspace_authorization_epochs SET authorization_epoch = 2 WHERE workspace_id = ? AND human_id = ?",
          )
          .run(FIX.workspace, FIX.owner);
        await f.db
          .prepare(
            "UPDATE workspace_members SET authorization_epoch = 2 WHERE workspace_id = ? AND human_id = ?",
          )
          .run(FIX.workspace, FIX.owner);
      });
      if (mode === "list")
        expect(await listGitHubEvidence(db, FIX.workspace, {}, access())).toEqual([]);
      else
        expect(
          await getEvidenceVerificationStatus(
            db,
            FIX.workspace,
            [{ kind: "github", ref: `github:1234:commit:${CANARY}` }],
            {},
            access(),
          ),
        ).toEqual([
          { kind: "github", ref: `github:1234:commit:${CANARY}`, provenance: "unverified" },
        ]);
    },
  );
  it("denies a private parent introduced at the committing guard", async () => {
    const f = await fixture();
    const db = before(f.db, /INSERT INTO runner_mutation_guards/, () => privacy(f.db, f.task.id));
    const outcome = await new WorkspaceHub(db).execute(linkGitHubEvidenceCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.member,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input: f.input,
    });
    expect(outcome.ok).toBe(false);
    expect(await f.db.prepare("SELECT id FROM github_evidence").all()).toEqual([]);
  });
  it("keeps shared creation/cache and null missing-parent denial working on staged D1", async () => {
    const f = await fixture(),
      hub = new WorkspaceHub(stagedD1(f.db)),
      key = randomUlid();
    const envelope = {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.member,
      authorizationEpoch: 1,
      idempotencyKey: key,
      input: f.input,
    };
    const row = success(await hub.execute(linkGitHubEvidenceCommand, envelope));
    expect(success(await hub.execute(linkGitHubEvidenceCommand, envelope))).toEqual(row);
    expect(
      await hub.execute(linkGitHubEvidenceCommand, {
        ...envelope,
        idempotencyKey: randomUlid(),
        input: { ...f.input, taskId: randomUlid() },
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found", message: "task not found" } });
  });
  it.each(["requested", "retained", "epoch", "role"])(
    "rejects %s authority changed at D1 batch commit without effects",
    async (mode) => {
      const f = await fixture();
      const original = mode === "retained" ? success(await f.execute()) : null;
      const input = mode === "retained" ? { ...f.input, taskId: undefined } : f.input;
      const db = stagedD1(f.db, async () => {
        if (mode === "epoch") {
          await f.db
            .prepare(
              "UPDATE workspace_authorization_epochs SET authorization_epoch = 2 WHERE human_id = ?",
            )
            .run(FIX.member);
          await f.db
            .prepare("UPDATE workspace_members SET authorization_epoch = 2 WHERE human_id = ?")
            .run(FIX.member);
        } else if (mode === "role")
          await f.db
            .prepare("UPDATE workspace_members SET role = 'reviewer' WHERE human_id = ?")
            .run(FIX.member);
        else await privacy(f.db, f.task.id);
      });
      const outcome = await new WorkspaceHub(db).execute(linkGitHubEvidenceCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.member,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        input,
      });
      expect(outcome).toMatchObject({
        ok: false,
        error: { code: "command_failed", message: "command failed" },
      });
      const rows = await f.db
        .prepare("SELECT id,task_id,resource_version FROM github_evidence")
        .all();
      expect(rows).toEqual(
        original ? [{ id: original.id, task_id: f.task.id, resource_version: 1 }] : [],
      );
      expect(
        (
          (await f.db
            .prepare("SELECT event_id FROM semantic_events WHERE kind = 'github.evidence.link'")
            .all()) as unknown[]
        ).length,
      ).toBe(original ? 1 : 0);
    },
  );
  it("rechecks cache delivery after the idempotency record lookup", async () => {
    const f = await fixture(),
      key = randomUlid();
    success(await f.execute(f.input, key));
    const db = before(stagedD1(f.db), /FROM idempotency_records/, () => privacy(f.db, f.task.id));
    expect(
      await new WorkspaceHub(db).execute(linkGitHubEvidenceCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.member,
        authorizationEpoch: 1,
        idempotencyKey: key,
        input: f.input,
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

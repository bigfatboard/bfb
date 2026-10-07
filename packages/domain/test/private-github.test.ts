// ABOUTME: Proves shared-only GitHub evidence delivery, retained lineage and current recipient authority.
// ABOUTME: Synthetic historical associations distinguish retained provenance from the beta manual-link hold.

import { createHash } from "node:crypto";
import { adaptD1, type D1Like, type D1StatementLike, type SqlDatabase } from "@bfb/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIX } from "../src/fixtures.js";
import {
  getEvidenceVerificationStatus,
  linkGitHubEvidenceCommand,
  listGitHubEvidence,
  type GitHubEvidenceRecord,
  type LinkGitHubEvidenceInput,
} from "../src/github.js";
import { WorkspaceHub } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { canonicalLaunchJson } from "../src/launch-state.js";
import { createTaskCommand } from "../src/work-commands.js";
import { openDomainDb } from "./helpers.js";
import { success } from "./launch-fixture.js";

const NOW = "2026-10-06T12:00:00.000Z";
const CANARY = "SYNTHETIC_GITHUB_REFERENCE_PROSE";
const MANUAL_HOLD = {
  ok: false,
  error: {
    code: "request_rejected",
    message: "manual GitHub evidence linking is unavailable",
  },
};
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
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function snapshot(db: SqlDatabase) {
  const tables = (await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  const canonical: Record<string, unknown[]> = {};
  const excluded: string[] = [];
  for (const { name } of tables) {
    if (["sqlite_sequence", "d1_migrations", "_cf_METADATA"].includes(name)) {
      excluded.push(name);
      continue;
    }
    if (name.startsWith("sqlite_") || name.startsWith("_cf_"))
      throw new Error(`unexpected snapshot engine table: ${name}`);
    expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/u);
    if (name !== "rate_limit_buckets")
      canonical[name] = await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  }
  return {
    canonical,
    budgets: await db.prepare("SELECT * FROM rate_limit_buckets ORDER BY rowid").all(),
    excluded,
  };
}

/** Explicit pre-hold history for reader tests, not a replacement manual-link path. */
async function historicalEvidence(f: Fixture, input: LinkGitHubEvidenceInput = f.input) {
  const row: GitHubEvidenceRecord = {
    id: randomUlid(),
    workspace_id: FIX.workspace,
    project_id: input.projectId,
    task_id: input.taskId ?? null,
    repository_id: input.repositoryId,
    kind: input.kind,
    ref: input.ref,
    version_token: input.versionToken,
    state: input.state ?? {},
    observed_by: input.observedBy,
    observed_at: NOW,
    resource_version: 1,
  };
  await f.db
    .prepare(
      `INSERT INTO github_evidence
       (workspace_id,id,project_id,task_id,repository_id,kind,ref,version_token,state_json,
        observed_by,observed_at,resource_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.workspace_id,
      row.id,
      row.project_id,
      row.task_id,
      row.repository_id,
      row.kind,
      row.ref,
      row.version_token,
      JSON.stringify(row.state),
      row.observed_by,
      row.observed_at,
      row.resource_version,
    );
  return row;
}

/** Synthetic retained cache and safe receipts remain immutable under held retries. */
async function historicalReceipts(
  f: Fixture,
  input: LinkGitHubEvidenceInput,
  key: string,
  result: GitHubEvidenceRecord,
) {
  const previous = (await f.db
    .prepare("SELECT cursor FROM workspace_cursors WHERE workspace_id=?")
    .get(FIX.workspace)) as { cursor: number };
  const cursor = previous.cursor + 1;
  const payload = JSON.stringify({
    actor: { humanId: FIX.member, authorizationEpoch: 1 },
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
        "INSERT INTO idempotency_records (workspace_id,idempotency_key,command_name,result_json,created_at) VALUES (?,?,?,?,?)",
      )
      .run(
        FIX.workspace,
        key,
        linkGitHubEvidenceCommand.name,
        JSON.stringify({
          result,
          cursor,
          authorizationEpoch: 1,
          actorHumanId: FIX.member,
          inputFingerprint: createHash("sha256")
            .update(canonicalLaunchJson(JSON.parse(JSON.stringify(input))))
            .digest("hex"),
        }),
        NOW,
      );
    await tx
      .prepare(
        "INSERT INTO semantic_events (workspace_id,event_id,workspace_cursor,kind,payload_json,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(FIX.workspace, randomUlid(), cursor, linkGitHubEvidenceCommand.name, payload, NOW);
    await tx
      .prepare(
        "INSERT INTO audit_events (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(FIX.workspace, randomUlid(), FIX.member, linkGitHubEvidenceCommand.name, payload, NOW);
    await tx
      .prepare(
        "INSERT INTO outbox_records (workspace_id,outbox_id,kind,payload_json,created_at,delivered_at) VALUES (?,?,?,?,?,NULL)",
      )
      .run(FIX.workspace, randomUlid(), linkGitHubEvidenceCommand.name, payload, NOW);
  });
}

/** Preserves D1 null-first reads and witnesses any attempted command batch. */
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
    await historicalEvidence(f);
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
    "holds private and missing association even for creator/owner %s",
    async (humanId) => {
      const f = await fixture();
      await privacy(f.db, f.task.id);
      const retained = await snapshot(f.db);
      const hidden = await f.execute(f.input, randomUlid(), humanId);
      const missing = await f.execute({ ...f.input, taskId: randomUlid() }, randomUlid(), humanId);
      expect(hidden).toEqual(MANUAL_HOLD);
      expect(hidden).toEqual(missing);
      expect(await f.db.prepare("SELECT id FROM github_evidence").all()).toEqual([]);
      expect(await snapshot(f.db)).toEqual(retained);
      expect(await f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    },
  );
  it("filters historical private evidence before limit and excludes it from provenance", async () => {
    const f = await fixture();
    const publicRow = await historicalEvidence(f, {
      ...f.input,
      taskId: undefined,
      ref: "public-ref",
    });
    await historicalEvidence(f);
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
    await historicalEvidence(f);
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
  it("holds omitted-task manual retries without detaching retained private history", async () => {
    const f = await fixture(),
      row = await historicalEvidence(f);
    await privacy(f.db, f.task.id);
    const retained = await snapshot(f.db);
    expect(await f.execute({ ...f.input, taskId: undefined, versionToken: "changed" })).toEqual(
      MANUAL_HOLD,
    );
    expect(
      await f.db
        .prepare(
          "SELECT task_id, resource_version, version_token FROM github_evidence WHERE id = ?",
        )
        .get(row.id),
    ).toEqual({ task_id: f.task.id, resource_version: 1, version_token: f.input.versionToken });
    expect(await snapshot(f.db)).toEqual(retained);
  });
  it("holds a retained project-only cached reply without rewriting its later private association", async () => {
    const f = await fixture(),
      key = randomUlid(),
      unbound = { ...f.input, taskId: undefined };
    const row = await historicalEvidence(f);
    await historicalReceipts(f, unbound, key, { ...row, task_id: null });
    await privacy(f.db, f.task.id);
    const retained = await snapshot(f.db);
    expect(await f.execute(unbound, key)).toEqual(MANUAL_HOLD);
    expect(await snapshot(f.db)).toEqual(retained);
  });
  it("holds exact and changed-input retries while retaining metadata-only historical receipts", async () => {
    const f = await fixture(),
      key = randomUlid();
    const row = await historicalEvidence(f);
    await historicalReceipts(f, f.input, key, row);
    const retained = await snapshot(f.db);
    expect(await f.execute(f.input, key)).toEqual(MANUAL_HOLD);
    expect(await f.execute({ ...f.input, state: { summary: "changed" } }, key)).toEqual(
      MANUAL_HOLD,
    );
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
    expect(await snapshot(f.db)).toEqual(retained);
  });
  it.each(["list", "verification"])(
    "checks current recipient epoch in %s selection",
    async (mode) => {
      const f = await fixture();
      await historicalEvidence(f);
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
  it("holds manual linking before any committing guard lookup", async () => {
    const f = await fixture();
    const retained = await snapshot(f.db);
    let guardReached = false;
    const db = before(f.db, /INSERT INTO runner_mutation_guards/, async () => {
      guardReached = true;
      await privacy(f.db, f.task.id);
    });
    const outcome = await new WorkspaceHub(db).execute(linkGitHubEvidenceCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.member,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input: f.input,
    });
    expect(outcome).toEqual(MANUAL_HOLD);
    expect(guardReached).toBe(false);
    expect(await f.db.prepare("SELECT id FROM github_evidence").all()).toEqual([]);
    expect(await snapshot(f.db)).toEqual(retained);
  });
  it("holds shared fresh, historical-cache and missing-parent attempts on staged D1", async () => {
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
    const row = await historicalEvidence(f);
    await historicalReceipts(f, f.input, key, row);
    const retained = await snapshot(f.db);
    expect(
      await hub.execute(linkGitHubEvidenceCommand, { ...envelope, idempotencyKey: randomUlid() }),
    ).toEqual(MANUAL_HOLD);
    expect(await hub.execute(linkGitHubEvidenceCommand, envelope)).toEqual(MANUAL_HOLD);
    expect(
      await hub.execute(linkGitHubEvidenceCommand, {
        ...envelope,
        idempotencyKey: randomUlid(),
        input: { ...f.input, taskId: randomUlid() },
      }),
    ).toEqual(MANUAL_HOLD);
    expect(await snapshot(f.db)).toEqual(retained);
    expect(await f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it.each(["new", "historical"])(
    "holds %s manual targets before any D1 batch is staged",
    async (mode) => {
      const f = await fixture();
      if (mode === "historical") await historicalEvidence(f);
      const input = mode === "historical" ? { ...f.input, taskId: undefined } : f.input;
      const retained = await snapshot(f.db);
      let batchReached = false;
      const db = stagedD1(f.db, async () => {
        batchReached = true;
        await privacy(f.db, f.task.id);
      });
      const outcome = await new WorkspaceHub(db).execute(linkGitHubEvidenceCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.member,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        input,
      });
      expect(outcome).toEqual(MANUAL_HOLD);
      expect(batchReached).toBe(false);
      expect(await snapshot(f.db)).toEqual(retained);
      expect(await f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    },
  );
  it("holds a cached manual reply before the idempotency record lookup", async () => {
    const f = await fixture(),
      key = randomUlid();
    const row = await historicalEvidence(f);
    await historicalReceipts(f, f.input, key, row);
    const retained = await snapshot(f.db);
    let cacheReached = false;
    const db = before(stagedD1(f.db), /FROM idempotency_records/, async () => {
      cacheReached = true;
      await privacy(f.db, f.task.id);
    });
    expect(
      await new WorkspaceHub(db).execute(linkGitHubEvidenceCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.member,
        authorizationEpoch: 1,
        idempotencyKey: key,
        input: f.input,
      }),
    ).toEqual(MANUAL_HOLD);
    expect(cacheReached).toBe(false);
    expect(await snapshot(f.db)).toEqual(retained);
    expect(await f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

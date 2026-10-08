// ABOUTME: Proves human discussion history requires an exact current shared parent and retained viewer authority.
// ABOUTME: Private and late-revoked history cannot escape through hydration, advisories or pagination metadata.

import type { SqlDatabase } from "@bfb/db";
import type { DiscussionChangeRequest } from "@bfb/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPrincipal } from "../src/authorization.js";
import { listTaskDiscussions, readHumanDiscussion } from "../src/discussion-views.js";
import { changeDiscussionCommand } from "../src/discussions.js";
import { FIX } from "../src/fixtures.js";
import { randomUlid } from "../src/ids.js";
import { discussionFixture, HUMAN_ONLY_CANARY, SYNTHETIC_OUTPUT } from "./discussion-fixture.js";
import { LAUNCH_NOW, success } from "./launch-fixture.js";

const DETAIL_DENIAL = { code: "not_found", message: "discussion not found" };
const LIST_DENIAL = { code: "not_found", message: "discussion task not found" };
const LOSSES = ["privacy", "project", "epoch"] as const;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(LAUNCH_NOW));
});
afterEach(() => vi.useRealTimers());

function change(
  id: string,
  version: number,
  action: DiscussionChangeRequest["action"],
  fields: Record<string, unknown> = {},
) {
  return {
    schema_version: 1,
    idempotency_key: randomUlid(),
    discussion_id: id,
    expected_version: version,
    action,
    ...fields,
  } as DiscussionChangeRequest;
}

async function history() {
  const f = await discussionFixture(),
    created = await f.create({ rounds: 1 }),
    id = created.discussion_id;
  success(
    await f.human(
      changeDiscussionCommand,
      change(id, created.version, "intervene", { text: "Synthetic retained clarification" }),
    ),
  );
  const first = await f.complete(id, 1);
  await f.complete(id, 2);
  const concluded = success(
    await f.human(
      changeDiscussionCommand,
      change(id, (await f.row(id)).resource_version, "conclude"),
    ),
  );
  const decision = success(
    await f.human(
      changeDiscussionCommand,
      change(id, concluded.version, "decide", {
        decision: {
          kind: "record_recommendation",
          summary: "Synthetic retained human decision",
          recommendation_ids: [first.message_id],
        },
      }),
    ),
  );
  return { ...f, id, decision };
}
type Fixture = Awaited<ReturnType<typeof history>>;

async function privatize(f: Pick<Fixture, "db" | "task">) {
  // Synthetic policy only; private creation is not a product command in C11.
  await f.db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, f.task.id, FIX.owner, LAUNCH_NOW);
}

async function retainedHistory(db: SqlDatabase) {
  const result: Record<string, unknown> = {};
  for (const table of [
    "discussions",
    "discussion_participants",
    "discussion_turns",
    "discussion_deliveries",
    "discussion_messages",
    "discussion_conclusions",
    "discussion_decisions",
    "discussion_session_bindings",
    "discussion_command_receipts",
    "runs",
    "run_executions",
    "run_configuration_snapshots",
    "provider_sessions",
    "audit_events",
    "semantic_events",
    "idempotency_records",
    "outbox_records",
    "workspace_cursors",
  ])
    result[table] = await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return result;
}

function atRead(
  db: SqlDatabase,
  matches: (sql: string) => boolean,
  effect: () => Promise<void>,
  after = false,
) {
  let fired = false;
  const statements: string[] = [];
  const run = async (sql: string) => {
    if (!fired && matches(sql)) {
      fired = true;
      await effect();
    }
  };
  return {
    statements,
    fired: () => fired,
    db: {
      ...db,
      prepare(sql: string) {
        statements.push(sql);
        const statement = db.prepare(sql);
        return {
          ...statement,
          async get(...params: unknown[]) {
            if (!after) await run(sql);
            const result = await statement.get(...params);
            if (after) await run(sql);
            return result;
          },
          async all(...params: unknown[]) {
            if (!after) await run(sql);
            const result = await statement.all(...params);
            if (after) await run(sql);
            return result;
          },
        };
      },
    },
  };
}

async function loseAccess(f: Pick<Fixture, "db" | "task">, loss: string) {
  if (loss === "privacy") await privatize(f);
  else if (loss === "project") {
    await f.db
      .prepare("UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id=?")
      .run(FIX.workspace, FIX.projectA);
    await f.db
      .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
      .run(FIX.workspace, FIX.projectA, FIX.member);
  } else {
    await f.db
      .prepare(
        "UPDATE workspace_members SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
      )
      .run(FIX.workspace, FIX.member);
    await f.db
      .prepare(
        "UPDATE workspace_authorization_epochs SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
      )
      .run(FIX.workspace, FIX.member);
  }
}

describe("human shared discussion delivery", () => {
  it("returns genuine attributed recommendations, conclusion and decision without changing history", async () => {
    const f = await history();
    const before = await retainedHistory(f.db);
    for (const humanId of [FIX.owner, FIX.member, FIX.reviewer]) {
      const principal = await loadPrincipal(f.db, FIX.workspace, humanId);
      const result = await readHumanDiscussion(f.db, principal, f.id, LAUNCH_NOW);
      expect(result).toMatchObject({
        scope: "human",
        discussion_id: f.id,
        task_id: f.task.id,
        state: "concluded",
        decision: { id: f.decision.decision_id, summary: "Synthetic retained human decision" },
      });
      expect(result.participants).toHaveLength(2);
      expect(result.turns).toHaveLength(2);
      expect(result.messages).toHaveLength(3);
      expect(
        result.messages.filter((row) => row.kind === "recommendation").map((row) => row.output),
      ).toEqual([SYNTHETIC_OUTPUT, SYNTHETIC_OUTPUT]);
      expect(result.conclusion?.recommendation_ids).toHaveLength(2);
      expect(JSON.stringify(result)).not.toContain(HUMAN_ONLY_CANARY);
    }
    expect(await retainedHistory(f.db)).toEqual(before);
  });

  it.each(["creator", "read", "contribute", "edit"])(
    "denies private %s detail/list before hydration without rewriting retained history",
    async (permission) => {
      const f = await history();
      await privatize(f);
      const humanId = permission === "creator" ? FIX.owner : FIX.member;
      if (permission !== "creator")
        await f.db
          .prepare(
            "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,?,?)",
          )
          .run(FIX.workspace, randomUlid(), f.task.id, humanId, permission, LAUNCH_NOW);
      const principal = await loadPrincipal(f.db, FIX.workspace, humanId),
        before = await retainedHistory(f.db),
        tracked = atRead(
          f.db,
          () => false,
          async () => {},
        );
      await expect(
        readHumanDiscussion(tracked.db, principal, f.id, LAUNCH_NOW),
      ).rejects.toMatchObject(DETAIL_DENIAL);
      await expect(listTaskDiscussions(tracked.db, principal, f.task.id)).rejects.toMatchObject(
        LIST_DENIAL,
      );
      expect(
        tracked.statements.some((sql) =>
          /FROM discussion_(participants|messages|decisions)/.test(sql),
        ),
      ).toBe(false);
      expect(await retainedHistory(f.db)).toEqual(before);
    },
  );

  it.each(
    LOSSES.flatMap((loss) => ["decision", "advisory"].map((phase) => [phase, loss] as const)),
  )("rechecks %s hydration after %s loss", async (phase, loss) => {
    const f = await history(),
      principal = await loadPrincipal(f.db, FIX.workspace, FIX.member),
      before = await retainedHistory(f.db);
    const staged = atRead(
      f.db,
      (sql) =>
        sql.includes(
          phase === "decision" ? "FROM discussion_decisions" : "FROM task_context_items AS item",
        ),
      () => loseAccess(f, loss),
      true,
    );
    await expect(readHumanDiscussion(staged.db, principal, f.id, LAUNCH_NOW)).rejects.toMatchObject(
      DETAIL_DENIAL,
    );
    expect(staged.fired()).toBe(true);
    expect(await retainedHistory(f.db)).toEqual(before);
  });

  it.each(LOSSES.flatMap((loss) => [false, true].map((empty) => [empty, loss] as const)))(
    "checks final list parent/scope when empty=%s after %s loss",
    async (empty, loss) => {
      const f = empty ? await discussionFixture() : await history(),
        principal = await loadPrincipal(f.db, FIX.workspace, FIX.member),
        before = await retainedHistory(f.db);
      const staged = atRead(
        f.db,
        (sql) => /FROM discussions\b/.test(sql),
        () => loseAccess(f, loss),
      );
      await expect(
        listTaskDiscussions(staged.db, principal, f.task.id, { limit: 1 }),
      ).rejects.toMatchObject(LIST_DENIAL);
      expect(staged.fired()).toBe(true);
      expect(await retainedHistory(f.db)).toEqual(before);
    },
  );

  it("retains a genuine shared sponsor-revocation advisory for a currently authorized viewer", async () => {
    const f = await history(),
      principal = await loadPrincipal(f.db, FIX.workspace, FIX.member),
      before = await retainedHistory(f.db);
    await f.db
      .prepare(
        "UPDATE workspace_members SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
      )
      .run(FIX.workspace, FIX.owner);
    await f.db
      .prepare(
        "UPDATE workspace_authorization_epochs SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
      )
      .run(FIX.workspace, FIX.owner);
    const result = await readHumanDiscussion(f.db, principal, f.id, LAUNCH_NOW);
    expect(result.dispatch_block_reason).toBe("sponsor_revoked");
    expect(result.messages).toHaveLength(3);
    expect(result.decision?.id).toBe(f.decision.decision_id);
    expect(await retainedHistory(f.db)).toEqual(before);
  });

  it("denies missing and misbound detail parents uniformly and omits misbound list rows", async () => {
    const f = await history(),
      principal = await loadPrincipal(f.db, FIX.workspace, FIX.owner);
    await expect(
      readHumanDiscussion(f.db, principal, randomUlid(), LAUNCH_NOW),
    ).rejects.toMatchObject(DETAIL_DENIAL);
    // Synthetic historical parent corruption, without touching immutable discussion records.
    await f.db.prepare("PRAGMA foreign_keys=OFF").run();
    try {
      await f.db
        .prepare("UPDATE tasks SET project_id=? WHERE workspace_id=? AND id=?")
        .run(FIX.projectB, FIX.workspace, f.task.id);
    } finally {
      await f.db.prepare("PRAGMA foreign_keys=ON").run();
    }
    const before = await retainedHistory(f.db);
    await expect(readHumanDiscussion(f.db, principal, f.id, LAUNCH_NOW)).rejects.toMatchObject(
      DETAIL_DENIAL,
    );
    expect(await listTaskDiscussions(f.db, principal, f.task.id)).toEqual({
      schema_version: 1,
      discussions: [],
      has_more: false,
    });
    expect(await retainedHistory(f.db)).toEqual(before);
  });

  it("preserves ID ordering, bounded pages and structural pagination errors", async () => {
    const f = await discussionFixture();
    const ids = [];
    for (let index = 0; index < 3; index++)
      ids.push((await f.create({ rounds: 1, idempotency_key: randomUlid() })).discussion_id);
    ids.sort();
    const principal = await loadPrincipal(f.db, FIX.workspace, FIX.owner);
    let cursor: string | undefined;
    for (let index = 0; index < ids.length; index++) {
      const page = await listTaskDiscussions(f.db, principal, f.task.id, { limit: 1, cursor });
      expect(page.discussions.map((row) => row.id)).toEqual([ids[index]]);
      expect(page.has_more).toBe(index < ids.length - 1);
      expect(page.next_cursor).toBe(index < ids.length - 1 ? ids[index] : undefined);
      cursor = ids[index];
    }
    expect(await listTaskDiscussions(f.db, principal, f.task.id, { cursor })).toEqual({
      schema_version: 1,
      discussions: [],
      has_more: false,
    });
    expect((await listTaskDiscussions(f.db, principal, f.task.id)).discussions).toHaveLength(3);
    expect(
      (await listTaskDiscussions(f.db, principal, f.task.id, { limit: 50 })).discussions,
    ).toHaveLength(3);
    for (const options of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { cursor: "malformed" }])
      await expect(listTaskDiscussions(f.db, principal, f.task.id, options)).rejects.toMatchObject({
        code: "invalid_argument",
        message: "discussion pagination is invalid",
      });
  });

  it("does not adopt a newer viewer epoch and denies empty scope or missing tasks", async () => {
    const f = await discussionFixture(),
      principal = await loadPrincipal(f.db, FIX.workspace, FIX.member);
    await loseAccess(f, "epoch");
    await expect(listTaskDiscussions(f.db, principal, f.task.id)).rejects.toMatchObject(
      LIST_DENIAL,
    );
    await expect(
      readHumanDiscussion(f.db, principal, randomUlid(), LAUNCH_NOW),
    ).rejects.toMatchObject(DETAIL_DENIAL);
    const current = await loadPrincipal(f.db, FIX.workspace, FIX.member);
    expect(await listTaskDiscussions(f.db, current, f.task.id)).toEqual({
      schema_version: 1,
      discussions: [],
      has_more: false,
    });
    await expect(listTaskDiscussions(f.db, current, randomUlid())).rejects.toMatchObject(
      LIST_DENIAL,
    );
  });
});

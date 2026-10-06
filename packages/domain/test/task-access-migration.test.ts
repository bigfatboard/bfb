// ABOUTME: Proves dormant private-task schema preserves shared work and enforces tenant/creator bindings.
// ABOUTME: Rejects policy reopening, grant authority mutation and epoch rebinding with synthetic rows.

import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptBetterSqlite3, applyMigrationsForVerification } from "@bfb/db";
import { FIX, seedSyntheticWorkspace } from "../src/fixtures.js";
import { WorkspaceHub } from "../src/hub.js";
import { createTaskCommand } from "../src/work-commands.js";
import { randomUlid } from "../src/ids.js";

const directory = fileURLToPath(new URL("../../../migrations/d1", import.meta.url));
const now = "2026-10-06T12:00:00.000Z";

async function fixture(previous = false) {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  applyMigrationsForVerification(
    raw,
    directory,
    previous ? { stopBeforeId: "0045_private_task_authority" } : {},
  );
  const db = adaptBetterSqlite3(raw);
  await seedSyntheticWorkspace(db);
  const outcome = await new WorkspaceHub(db).execute(createTaskCommand, {
    workspaceId: FIX.workspace,
    actorHumanId: FIX.member,
    authorizationEpoch: 1,
    now,
    idempotencyKey: randomUlid(),
    input: {
      projectId: FIX.projectA,
      title: "Synthetic private authority fixture",
      priority: "P2",
    },
  });
  if (!outcome.ok) throw new Error(outcome.error.code);
  return { raw, taskId: outcome.result.id };
}

function policy(raw: Database.Database, taskId: string, owner = FIX.member) {
  raw
    .prepare(
      `INSERT INTO task_privacy
    (workspace_id, task_id, owner_human_id, access_version, created_at)
    VALUES (?, ?, ?, 1, ?)`,
    )
    .run(FIX.workspace, taskId, owner, now);
}
function grant(raw: Database.Database, taskId: string) {
  const id = randomUlid();
  raw
    .prepare(
      `INSERT INTO task_human_grants
    (workspace_id, id, task_id, human_id, authorization_epoch, permission, created_at)
    VALUES (?, ?, ?, ?, 1, 'read', ?)`,
    )
    .run(FIX.workspace, id, taskId, FIX.owner, now);
  return id;
}

describe("private task authority migration", () => {
  it("cannot pre-authorize a future membership epoch or a currently revoked recipient", async () => {
    const { raw, taskId } = await fixture();
    try {
      policy(raw, taskId);
      const insert = raw.prepare(`INSERT INTO task_human_grants
        (workspace_id, id, task_id, human_id, authorization_epoch, permission, created_at)
        VALUES (?, ?, ?, ?, ?, 'read', ?)`);
      expect(() => insert.run(FIX.workspace, randomUlid(), taskId, FIX.owner, 2, now)).toThrow(
        /epoch/,
      );
      raw
        .prepare("UPDATE workspace_authorization_epochs SET revoked_at = ? WHERE human_id = ?")
        .run(now, FIX.reviewer);
      expect(() => grant(raw, taskId)).not.toThrow();
      expect(() => insert.run(FIX.workspace, randomUlid(), taskId, FIX.reviewer, 1, now)).toThrow(
        /epoch/,
      );
    } finally {
      raw.close();
    }
  });
  it("expands previous schema without changing or privatizing existing work", async () => {
    const { raw } = await fixture(true);
    try {
      const before = raw.prepare("SELECT * FROM tasks ORDER BY id").all();
      expect(applyMigrationsForVerification(raw, directory).head).toBe(
        "0045_private_task_authority",
      );
      expect(raw.prepare("SELECT * FROM tasks ORDER BY id").all()).toEqual(before);
      expect(raw.prepare("SELECT COUNT(*) AS n FROM task_privacy").get()).toEqual({ n: 0 });
      expect(raw.prepare("SELECT COUNT(*) AS n FROM task_human_grants").get()).toEqual({ n: 0 });
      expect(raw.pragma("foreign_key_check")).toEqual([]);
    } finally {
      raw.close();
    }
  });

  it("binds policy to the real task creator and prevents fallback to shared access", async () => {
    const { raw, taskId } = await fixture();
    try {
      expect(() => policy(raw, taskId, FIX.owner)).toThrow(/creator/);
      expect(() => policy(raw, randomUlid())).toThrow();
      policy(raw, taskId);
      expect(() => policy(raw, taskId)).toThrow(/UNIQUE/);
      expect(() => raw.prepare("DELETE FROM task_privacy").run()).toThrow(/retained/);
      for (const [column, value] of [
        ["owner_human_id", FIX.owner],
        ["task_id", randomUlid()],
        ["workspace_id", randomUlid()],
        ["created_at", "2026-10-07T12:00:00.000Z"],
      ]) {
        expect(() => raw.prepare(`UPDATE task_privacy SET ${column} = ?`).run(value)).toThrow(
          /immutable/,
        );
      }
      expect(() =>
        raw.prepare("UPDATE tasks SET created_by_human_id = ? WHERE id = ?").run(FIX.owner, taskId),
      ).toThrow(/creator/);
      expect(() => raw.prepare("UPDATE task_privacy SET access_version = 0").run()).toThrow(
        /CHECK/,
      );
    } finally {
      raw.close();
    }
  });

  it("rejects unbound grants and invalid permissions/epochs", async () => {
    const { raw, taskId } = await fixture();
    try {
      expect(() => grant(raw, taskId)).toThrow(/FOREIGN KEY/);
      policy(raw, taskId);
      grant(raw, taskId);
      expect(() => grant(raw, taskId)).toThrow(/UNIQUE/);
      for (const [human, epoch, permission] of [
        [randomUlid(), 1, "read"],
        [FIX.owner, 0, "read"],
        [FIX.owner, 1, "admin"],
        [FIX.owner, 1.5, "read"],
      ]) {
        expect(() =>
          raw
            .prepare(
              `INSERT INTO task_human_grants
          (workspace_id, id, task_id, human_id, authorization_epoch, permission, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(FIX.workspace, randomUlid(), taskId, human, epoch, permission, now),
        ).toThrow();
      }
    } finally {
      raw.close();
    }
  });

  it("retains grant identity and revocation while allowing an explicit new grant", async () => {
    const { raw, taskId } = await fixture();
    try {
      policy(raw, taskId);
      const id = grant(raw, taskId);
      for (const [column, value] of [
        ["human_id", FIX.reviewer],
        ["authorization_epoch", 2],
        ["permission", "edit"],
        ["task_id", randomUlid()],
        ["workspace_id", randomUlid()],
        ["id", randomUlid()],
      ]) {
        expect(() =>
          raw.prepare(`UPDATE task_human_grants SET ${column} = ? WHERE id = ?`).run(value, id),
        ).toThrow(/immutable/);
      }
      raw.prepare("UPDATE task_human_grants SET revoked_at = ? WHERE id = ?").run(now, id);
      expect(() =>
        raw.prepare("UPDATE task_human_grants SET revoked_at = NULL WHERE id = ?").run(id),
      ).toThrow(/revocation/);
      expect(() => raw.prepare("DELETE FROM task_human_grants WHERE id = ?").run(id)).toThrow(
        /retained/,
      );
      expect(grant(raw, taskId)).not.toBe(id);
      expect(raw.pragma("foreign_key_check")).toEqual([]);
    } finally {
      raw.close();
    }
  });

  it("rejects another tenant's human or task even when global human IDs are valid", async () => {
    const { raw, taskId } = await fixture();
    try {
      policy(raw, taskId);
      const otherWorkspace = randomUlid();
      const otherHuman = randomUlid();
      raw
        .prepare(
          "INSERT INTO workspaces (id, slug, jurisdiction, created_at) VALUES (?, 'synthetic-other-tenant', 'global', ?)",
        )
        .run(otherWorkspace, now);
      raw
        .prepare(
          "INSERT INTO humans (id, email, display_name, created_at) VALUES (?, 'other@synthetic.test', 'Synthetic Other', ?)",
        )
        .run(otherHuman, now);
      raw
        .prepare(
          `INSERT INTO workspace_authorization_epochs
        (workspace_id, human_id, authorization_epoch, updated_at) VALUES (?, ?, 1, ?)`,
        )
        .run(otherWorkspace, otherHuman, now);
      raw
        .prepare(
          `INSERT INTO workspace_members
        (workspace_id, human_id, role, authorization_epoch, created_at)
        VALUES (?, ?, 'owner', 1, ?)`,
        )
        .run(otherWorkspace, otherHuman, now);
      const insert = raw.prepare(`INSERT INTO task_human_grants
        (workspace_id, id, task_id, human_id, authorization_epoch, permission, created_at)
        VALUES (?, ?, ?, ?, 1, 'read', ?)`);
      expect(() => insert.run(FIX.workspace, randomUlid(), taskId, otherHuman, now)).toThrow(
        /epoch/,
      );
      expect(() => insert.run(otherWorkspace, randomUlid(), taskId, otherHuman, now)).toThrow(
        /FOREIGN KEY/,
      );
    } finally {
      raw.close();
    }
  });
});

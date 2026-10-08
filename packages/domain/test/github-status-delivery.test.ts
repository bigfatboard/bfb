// ABOUTME: Proves GitHub status retains current workspace authority and coherent installation/link fields.
// ABOUTME: Independent local authority and display changes remain separate from effect-free status reads.

import type { SqlDatabase } from "@bfb/db";
import { describe, expect, it } from "vitest";

import { bumpMemberEpoch, loadPrincipal } from "../src/authorization.js";
import { FIX } from "../src/fixtures.js";
import { getGitHubStatus, type GitHubStatusView } from "../src/github.js";
import { DomainError } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import type { TaskAccessContext } from "../src/task-access.js";
import { openDomainDb } from "./helpers.js";

const HISTORY = "2026-09-18T12:00:00.000Z";
const CHANGED = "2026-09-18T12:01:00.000Z";
const DENIAL = { code: "forbidden", message: "github status is unavailable" };
const ENGINE_TABLES = new Set(["sqlite_sequence", "d1_migrations", "_cf_METADATA"]);
type Row = Record<string, unknown>;
type Snapshot = { canonical: Record<string, Row[]>; budgets: Row[]; excluded: string[] };

// The OLD two-argument implementation legitimately ignores this third argument.
// This typed assignment invokes the real reader on both OLD and fixed source.
const readStatus: (
  db: SqlDatabase,
  workspaceId: string,
  access: TaskAccessContext,
) => Promise<GitHubStatusView> = getGitHubStatus;

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
  const budgets = (await db
    .prepare("SELECT * FROM rate_limit_buckets ORDER BY rowid")
    .all()) as Row[];
  return { canonical, budgets, excluded };
}

async function cleanForeignKeys(db: SqlDatabase) {
  expect(await db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(await db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

async function fixture(empty = false) {
  const db = await openDomainDb();
  const expected: GitHubStatusView = { installations: [], links: [] };
  if (!empty) {
    // Explicit synthetic installation/link records, not external GitHub activity.
    // Reverse insertion order proves the existing status ordering independently.
    for (const [installationId, slug, login] of [
      ["5678", "synthetic-second-app", "synthetic-second-account"],
      ["1234", "synthetic-first-app", "synthetic-first-account"],
    ] as const) {
      await db
        .prepare(
          `INSERT INTO github_app_installations
           (workspace_id,installation_id,app_id,app_slug,account_id,account_login,account_type,
            status,permissions_json,events_json,installed_by_human_id,created_at,updated_at,
            revoked_at,resource_version)
           VALUES (?,?, '42', ?, '84', ?, 'Organization', 'active', ?, ?, ?, ?, ?, NULL, 1)`,
        )
        .run(
          FIX.workspace,
          installationId,
          slug,
          login,
          JSON.stringify({ metadata: "read" }),
          JSON.stringify(["push"]),
          FIX.owner,
          HISTORY,
          HISTORY,
        );
    }
    expected.installations = [
      {
        installation_id: "1234",
        app_slug: "synthetic-first-app",
        account_login: "synthetic-first-account",
        status: "active",
        permissions: { metadata: "read" },
        events: ["push"],
        resource_version: 1,
      },
      {
        installation_id: "5678",
        app_slug: "synthetic-second-app",
        account_login: "synthetic-second-account",
        status: "active",
        permissions: { metadata: "read" },
        events: ["push"],
        resource_version: 1,
      },
    ];
    for (const [repositoryId, projectId, fullName, state] of [
      ["9002", FIX.projectB, "synthetic/beta", "active"],
      ["9001", FIX.projectA, "synthetic/alpha", "active"],
      ["9003", FIX.projectA, "synthetic/closed", "closed"],
    ] as const) {
      const id = randomUlid();
      await db
        .prepare(
          `INSERT INTO github_repository_links
           (workspace_id,id,repository_id,installation_id,project_id,full_name,
            default_branch,link_state,created_at,closed_at,resource_version)
           VALUES (?,?,?,'1234',?,?,'main',?,?,?,1)`,
        )
        .run(
          FIX.workspace,
          id,
          repositoryId,
          projectId,
          fullName,
          state,
          HISTORY,
          state === "closed" ? HISTORY : null,
        );
      if (state === "active")
        expected.links.push({
          link_id: id,
          workspace_id: FIX.workspace,
          repository_id: repositoryId,
          installation_id: "1234",
          project_id: projectId,
          full_name: fullName,
          default_branch: "main",
          link_state: "active",
          resource_version: 1,
        });
    }
    expected.links.reverse();
  }
  await cleanForeignKeys(db);
  return { db, expected };
}

function beforeFinalStatusSelection(db: SqlDatabase, change: () => Promise<void>) {
  let selections = 0;
  let afterChange: Snapshot | undefined;
  let seam: { sql: string; method: "get" | "all" | "run" } | undefined;
  function wrap(database: SqlDatabase): SqlDatabase {
    return {
      prepare(sql) {
        const statement = database.prepare(sql);
        const before = async (method: "get" | "all" | "run") => {
          // OLD: after the installation array is materialized, before links.
          // Fixed: before the one coherent statement containing both sources.
          if (selections === 0 && /\bgithub_repository_links\b/iu.test(sql)) {
            selections++;
            seam = { sql, method };
            await change();
            await cleanForeignKeys(db);
            afterChange = await snapshot(db);
          }
        };
        return {
          async get(...parameters) {
            await before("get");
            return statement.get(...parameters);
          },
          async all(...parameters) {
            await before("all");
            return statement.all(...parameters);
          },
          async run(...parameters) {
            await before("run");
            return statement.run(...parameters);
          },
        };
      },
      withTransaction: (fn) => database.withTransaction((tx) => fn(wrap(tx))),
    };
  }
  return {
    db: wrap(db),
    assertReached() {
      expect(selections).toBe(1);
      expect(seam?.method).not.toBe("run");
      expect(seam?.sql).toMatch(/\bgithub_repository_links\b/iu);
      expect(afterChange).toBeDefined();
      return afterChange!;
    },
  };
}

async function captureStatus(db: SqlDatabase, access: TaskAccessContext) {
  try {
    return { status: await readStatus(db, FIX.workspace, access) };
  } catch (error) {
    return { error };
  }
}

async function expectReadEffects(db: SqlDatabase, before: Snapshot) {
  const after = await snapshot(db);
  expect(after.canonical).toEqual(before.canonical);
  expect(after.budgets).toEqual(before.budgets);
  expect(after.excluded).toEqual(before.excluded);
  await cleanForeignKeys(db);
}

describe("GitHub status final workspace delivery", () => {
  it("preserves the complete ordered installation and active-link DTO for a current Owner", async () => {
    const f = await fixture();
    const access = await loadPrincipal(f.db, FIX.workspace, FIX.owner);
    const before = await snapshot(f.db);
    expect(await readStatus(f.db, FIX.workspace, access)).toEqual(f.expected);
    await expectReadEffects(f.db, before);
  });

  it("preserves workspace-wide Member status when neither linked project is accessible", async () => {
    const f = await fixture();
    await f.db
      .prepare("UPDATE projects SET access_mode='restricted' WHERE workspace_id=?")
      .run(FIX.workspace);
    const removed = await f.db
      .prepare("DELETE FROM project_access WHERE workspace_id=? AND human_id=?")
      .run(FIX.workspace, FIX.member);
    expect(removed.changes).toBe(2);
    const access = await loadPrincipal(f.db, FIX.workspace, FIX.member);
    expect(access.role).toBe("member");
    expect(access.projectIds).toEqual([]);
    const before = await snapshot(f.db);
    expect(await readStatus(f.db, FIX.workspace, access)).toEqual(f.expected);
    await expectReadEffects(f.db, before);
  });

  it("returns useful empty status for an authorized Member without read effects", async () => {
    const f = await fixture(true);
    const access = await loadPrincipal(f.db, FIX.workspace, FIX.member);
    const before = await snapshot(f.db);
    expect(await readStatus(f.db, FIX.workspace, access)).toEqual({ installations: [], links: [] });
    await expectReadEffects(f.db, before);
  });

  it("denies an initially current Reviewer without delivering either source array", async () => {
    const f = await fixture();
    const access = await loadPrincipal(f.db, FIX.workspace, FIX.reviewer);
    expect(access.role).toBe("reviewer");
    const before = await snapshot(f.db);
    const outcome = await captureStatus(f.db, access);
    expect.soft(outcome.error).toBeInstanceOf(DomainError);
    expect.soft(outcome.error).toMatchObject(DENIAL);
    expect.soft(outcome.status).toBeUndefined();
    await expectReadEffects(f.db, before);
  });

  it.each(["epoch", "removal", "demotion", "empty epoch"] as const)(
    "denies retained Member status after a witnessed late %s loss",
    async (loss) => {
      const f = await fixture(loss === "empty epoch");
      const access = await loadPrincipal(f.db, FIX.workspace, FIX.member);
      expect(access.authorizationEpoch).toBe(1);
      const seam = beforeFinalStatusSelection(f.db, async () => {
        if (loss === "epoch" || loss === "empty epoch") {
          expect(await bumpMemberEpoch(f.db, FIX.workspace, FIX.member)).toBe(2);
          expect(
            await f.db
              .prepare(
                "SELECT authorization_epoch FROM workspace_members WHERE workspace_id=? AND human_id=?",
              )
              .get(FIX.workspace, FIX.member),
          ).toEqual({ authorization_epoch: 2 });
        } else if (loss === "removal") {
          // Remove the mutable grants required by the membership foreign key.
          expect(
            (
              await f.db
                .prepare("DELETE FROM project_access WHERE workspace_id=? AND human_id=?")
                .run(FIX.workspace, FIX.member)
            ).changes,
          ).toBe(2);
          expect(
            (
              await f.db
                .prepare("DELETE FROM workspace_members WHERE workspace_id=? AND human_id=?")
                .run(FIX.workspace, FIX.member)
            ).changes,
          ).toBe(1);
          expect(
            await f.db
              .prepare("SELECT role FROM workspace_members WHERE workspace_id=? AND human_id=?")
              .get(FIX.workspace, FIX.member),
          ).toBeUndefined();
        } else {
          expect(
            (
              await f.db
                .prepare(
                  "UPDATE workspace_members SET role='reviewer' WHERE workspace_id=? AND human_id=?",
                )
                .run(FIX.workspace, FIX.member)
            ).changes,
          ).toBe(1);
          expect(
            await f.db
              .prepare("SELECT role FROM workspace_members WHERE workspace_id=? AND human_id=?")
              .get(FIX.workspace, FIX.member),
          ).toEqual({ role: "reviewer" });
        }
      });
      const outcome = await captureStatus(seam.db, access);
      const afterIndependentChange = seam.assertReached();
      expect(access.authorizationEpoch).toBe(1);
      expect.soft(outcome.error).toBeInstanceOf(DomainError);
      expect.soft(outcome.error).toMatchObject(DENIAL);
      expect.soft(outcome.status).toBeUndefined();
      await expectReadEffects(f.db, afterIndependentChange);
    },
  );

  it("does not restore a revoked retained epoch through synthetic same-epoch membership reinstatement", async () => {
    const f = await fixture();
    const access = await loadPrincipal(f.db, FIX.workspace, FIX.member);
    const seam = beforeFinalStatusSelection(f.db, async () => {
      // Synthetic robustness history: the real membership service is not claimed
      // to reinstate a removed member without advancing its authorization epoch.
      await f.db.withTransaction(async (tx) => {
        expect(
          (
            await tx
              .prepare("DELETE FROM project_access WHERE workspace_id=? AND human_id=?")
              .run(FIX.workspace, FIX.member)
          ).changes,
        ).toBe(2);
        expect(
          (
            await tx
              .prepare("DELETE FROM workspace_members WHERE workspace_id=? AND human_id=?")
              .run(FIX.workspace, FIX.member)
          ).changes,
        ).toBe(1);
        expect(
          (
            await tx
              .prepare(
                "UPDATE workspace_authorization_epochs SET revoked_at=?,updated_at=? WHERE workspace_id=? AND human_id=? AND authorization_epoch=1",
              )
              .run(CHANGED, CHANGED, FIX.workspace, FIX.member)
          ).changes,
        ).toBe(1);
        await tx
          .prepare(
            "INSERT INTO workspace_members (workspace_id,human_id,role,authorization_epoch,created_at) VALUES (?,?,'member',1,?)",
          )
          .run(FIX.workspace, FIX.member, HISTORY);
        await tx
          .prepare(
            "INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?),(?,?,?)",
          )
          .run(FIX.workspace, FIX.projectA, FIX.member, FIX.workspace, FIX.projectB, FIX.member);
      });
      expect(
        await f.db
          .prepare(
            `SELECT member.role,member.authorization_epoch,epoch.revoked_at
             FROM workspace_members AS member
             JOIN workspace_authorization_epochs AS epoch
               ON epoch.workspace_id=member.workspace_id AND epoch.human_id=member.human_id
             WHERE member.workspace_id=? AND member.human_id=?`,
          )
          .get(FIX.workspace, FIX.member),
      ).toEqual({ role: "member", authorization_epoch: 1, revoked_at: CHANGED });
    });
    const outcome = await captureStatus(seam.db, access);
    const afterIndependentChange = seam.assertReached();
    expect(access.authorizationEpoch).toBe(1);
    expect.soft(outcome.error).toBeInstanceOf(DomainError);
    expect.soft(outcome.error).toMatchObject(DENIAL);
    expect.soft(outcome.status).toBeUndefined();
    await expectReadEffects(f.db, afterIndependentChange);
  });

  it("returns installation and link display fields from the same current selection", async () => {
    const f = await fixture();
    const access = await loadPrincipal(f.db, FIX.workspace, FIX.owner);
    const seam = beforeFinalStatusSelection(f.db, async () => {
      await f.db.withTransaction(async (tx) => {
        expect(
          (
            await tx
              .prepare(
                `UPDATE github_app_installations SET app_slug=?,account_login=?,status='suspended',
                 permissions_json=?,events_json=?,updated_at=?,resource_version=2
                 WHERE workspace_id=? AND installation_id='1234' AND resource_version=1`,
              )
              .run(
                "synthetic-current-app",
                "synthetic-current-account",
                JSON.stringify({ metadata: "read", issues: "read" }),
                JSON.stringify(["push", "issues"]),
                CHANGED,
                FIX.workspace,
              )
          ).changes,
        ).toBe(1);
        expect(
          (
            await tx
              .prepare(
                `UPDATE github_repository_links SET full_name=?,default_branch=?,resource_version=2
                 WHERE workspace_id=? AND repository_id='9001' AND resource_version=1`,
              )
              .run("synthetic/current-alpha", "trunk", FIX.workspace)
          ).changes,
        ).toBe(1);
        expect(
          (
            await tx
              .prepare(
                `UPDATE github_repository_links SET link_state='closed',closed_at=?,resource_version=2
                 WHERE workspace_id=? AND repository_id='9002' AND link_state='active'`,
              )
              .run(CHANGED, FIX.workspace)
          ).changes,
        ).toBe(1);
      });
    });
    const status = await readStatus(seam.db, FIX.workspace, access);
    const afterIndependentChange = seam.assertReached();
    expect.soft(status).toEqual({
      installations: [
        {
          installation_id: "1234",
          app_slug: "synthetic-current-app",
          account_login: "synthetic-current-account",
          status: "suspended",
          permissions: { metadata: "read", issues: "read" },
          events: ["push", "issues"],
          resource_version: 2,
        },
        f.expected.installations[1],
      ],
      links: [
        {
          ...f.expected.links[0],
          full_name: "synthetic/current-alpha",
          default_branch: "trunk",
          resource_version: 2,
        },
      ],
    });
    await expectReadEffects(f.db, afterIndependentChange);
  });
});

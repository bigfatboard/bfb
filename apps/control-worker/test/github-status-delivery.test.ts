// ABOUTME: Exercises coherent GitHub status delivery through genuine mounted browser sessions.
// ABOUTME: Retained workspace authority, useful empty status and independent late source changes remain distinct.

import type { SqlDatabase } from "@bfb/db";
import { FIX, bumpMemberEpoch, randomUlid, seedSyntheticWorkspace } from "@bfb/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseAuthKeys } from "../src/auth/better-auth.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { createControlApp } from "../src/routes.js";
import {
  AUTH_TEST_ENV,
  openAuthTestContext,
  seedAuthSession,
  type AuthTestContext,
} from "./auth-helpers.js";

const NOW = "2026-10-08T12:00:00.000Z";
const ORIGIN = AUTH_TEST_ENV.APP_ORIGIN;
const BASE = `/api/v1/workspaces/${FIX.workspace}/github/status`;
const UNAVAILABLE = { error: "forbidden", message: "github status is unavailable" };
const MEMBER_CAPTURE = /^\s*SELECT membership\.role, epoch\.authorization_epoch\b/;
const STATUS_SOURCE = /\b(?:FROM|JOIN)\s+github_repository_links\b/;
const ENGINE_TABLES = new Set(["sqlite_sequence", "d1_migrations", "_cf_METADATA"]);
type Actor = "owner" | "member" | "reviewer";
type Snapshot = Record<string, unknown[]>;
interface HttpBudget {
  bucket_key: string;
  window_started_at: string;
  count: number;
  updated_at: string;
}
const contexts: AuthTestContext[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  for (const context of contexts.splice(0)) context.raw.close();
  vi.useRealTimers();
});

async function canonicalSnapshot(db: SqlDatabase): Promise<Snapshot> {
  const tables = (await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  const result: Snapshot = {};
  for (const { name } of tables) {
    // HTTP budget bookkeeping is separate; auth sessions and all domain tables remain covered.
    if (ENGINE_TABLES.has(name)) continue;
    if (name.startsWith("sqlite_") || name.startsWith("_cf_")) {
      throw new Error(`unexpected snapshot engine table: ${name}`);
    }
    if (name === "rate_limit_buckets") continue;
    expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/u);
    result[name] = await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  }
  return result;
}

async function httpBudgets(db: SqlDatabase): Promise<HttpBudget[]> {
  const rows = (await db
    .prepare(
      `SELECT bucket_key,window_started_at,count,updated_at
       FROM rate_limit_buckets ORDER BY bucket_key LIMIT 65`,
    )
    .all()) as HttpBudget[];
  // These finite GET fixtures cannot silently truncate unrelated HTTP bookkeeping.
  expect(rows.length).toBeLessThanOrEqual(64);
  for (const row of rows) {
    expect(Number.isSafeInteger(row.count) && row.count >= 0).toBe(true);
  }
  return rows;
}

async function foreignKeys(db: SqlDatabase) {
  expect(await db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

async function noReadEffects(db: SqlDatabase, requests: () => Promise<void>) {
  await foreignKeys(db);
  const before = await canonicalSnapshot(db);
  const budgetsBefore = await httpBudgets(db);
  await requests();
  expect.soft(await canonicalSnapshot(db)).toEqual(before);
  expect
    .soft(await httpBudgets(db), "status GET HTTP budgets remain unchanged")
    .toEqual(budgetsBefore);
  await foreignKeys(db);
}

async function unavailable(response: Response) {
  expect.soft(response.status).toBe(403);
  expect.soft(response.headers.get("cache-control")).toBe("no-store");
  expect.soft(await response.json()).toEqual(UNAVAILABLE);
}

async function fixture(populated = true) {
  const context = openAuthTestContext(NOW);
  contexts.push(context);
  const db = context.db;
  await seedSyntheticWorkspace(db, NOW);
  // Status is workspace-wide for Owner/Member, even without the second project's grant.
  await db
    .prepare(
      "DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id IN (?,?)",
    )
    .run(FIX.workspace, FIX.projectB, FIX.owner, FIX.member);
  const linkA = randomUlid();
  const linkB = randomUlid();
  const installations = [
    {
      installation_id: "1001",
      app_slug: "synthetic-status-app-b",
      account_login: "synthetic-status-account-b",
      status: "suspended",
      permissions: { metadata: "read" },
      events: ["push", "installation"],
      resource_version: 4,
    },
    {
      installation_id: "1002",
      app_slug: "synthetic-status-app-a",
      account_login: "synthetic-status-account-a",
      status: "active",
      permissions: { metadata: "read", checks: "read" },
      events: ["push", "check_run"],
      resource_version: 2,
    },
  ];
  const links = [
    {
      link_id: linkB,
      workspace_id: FIX.workspace,
      repository_id: "9001",
      installation_id: "1001",
      project_id: FIX.projectB,
      full_name: "synthetic-status/repository-b",
      default_branch: "main",
      link_state: "active",
      resource_version: 3,
    },
    {
      link_id: linkA,
      workspace_id: FIX.workspace,
      repository_id: "9002",
      installation_id: "1002",
      project_id: FIX.projectA,
      full_name: "synthetic-status/repository-a",
      default_branch: "trunk",
      link_state: "active",
      resource_version: 1,
    },
  ];
  if (populated) {
    // Explicit synthetic retained integration fixtures, not a webhook or installation-authority proof.
    for (const row of installations) {
      await db
        .prepare(
          `INSERT INTO github_app_installations
           (workspace_id,installation_id,app_id,app_slug,account_id,account_login,account_type,status,
            permissions_json,events_json,installed_by_human_id,created_at,updated_at,revoked_at,resource_version)
           VALUES (?,?,'1234',?,'5678',?,'Organization',?,?,?,?,?,?,NULL,?)`,
        )
        .run(
          FIX.workspace,
          row.installation_id,
          row.app_slug,
          row.account_login,
          row.status,
          JSON.stringify(row.permissions),
          JSON.stringify(row.events),
          FIX.owner,
          NOW,
          NOW,
          row.resource_version,
        );
    }
    for (const row of links) {
      await db
        .prepare(
          `INSERT INTO github_repository_links
           (workspace_id,id,repository_id,installation_id,project_id,full_name,default_branch,
            link_state,created_at,closed_at,resource_version) VALUES (?,?,?,?,?,?,?,'active',?,NULL,?)`,
        )
        .run(
          row.workspace_id,
          row.link_id,
          row.repository_id,
          row.installation_id,
          row.project_id,
          row.full_name,
          row.default_branch,
          NOW,
          row.resource_version,
        );
    }
    await db
      .prepare(
        `INSERT INTO github_repository_links
         (workspace_id,id,repository_id,installation_id,project_id,full_name,default_branch,
          link_state,created_at,closed_at,resource_version)
         VALUES (?,?,'9003','1002',?,'synthetic-status/closed-history','old','closed',?,?,5)`,
      )
      .run(FIX.workspace, randomUlid(), FIX.projectA, NOW, NOW);
  }
  const actors = {} as Record<Actor, { cookie: string; csrf: string }>;
  const mounted = (database = db) => {
    const bindings = {
      DB: {},
      ARTIFACTS: {},
      ASSETS: {},
      JOBS: {},
      JOBS_DLQ: {},
      WORKSPACE_HUB: createTestWorkspaceHubNamespace(database),
      APP_ORIGIN: ORIGIN,
      ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
      LAUNCH_ORIGIN: "https://launch.bfb.example.test",
      JURISDICTION: "eu",
      ENVIRONMENT: "local",
    } as unknown as ControlBindings;
    const app = createControlApp(validateControlEnv(bindings), {
      db: database,
      now: NOW,
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      humanAuth: () => ({
        auth: context.auth,
        keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
        abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      }),
    });
    return { app, bindings };
  };
  for (const [actor, humanId] of [
    ["owner", FIX.owner],
    ["member", FIX.member],
    ["reviewer", FIX.reviewer],
  ] as const) {
    const session = await seedAuthSession(context, {
      userId: `status-${actor}-user`,
      sessionId: `status-${actor}-session`,
      token: `status-${actor}-token`,
      email: `${actor}@synthetic.test`,
      humanId,
      now: NOW,
    });
    const { app, bindings } = mounted();
    const response = await app.request(
      new Request(ORIGIN + "/auth/session", { headers: { cookie: session.cookie } }),
      undefined,
      bindings,
    );
    expect(response.status).toBe(200);
    actors[actor] = {
      cookie: session.cookie,
      csrf: ((await response.json()) as { csrf_token: string }).csrf_token,
    };
  }
  const request = (actor: Actor = "member", database = db) => {
    const { app, bindings } = mounted(database);
    return app.request(
      new Request(ORIGIN + BASE, {
        headers: { cookie: actors[actor].cookie, "x-bfb-csrf": actors[actor].csrf },
      }),
      undefined,
      bindings,
    );
  };
  await foreignKeys(db);
  return {
    db,
    request,
    installations: populated ? installations : [],
    links: populated ? links : [],
    linkA,
  };
}

function beforeStatusSelection(db: SqlDatabase, change: () => Promise<void>) {
  let captured = 0;
  let fired = false;
  let afterChange: Snapshot | undefined;
  let budgetsAfterChange: HttpBudget[] | undefined;
  const database: SqlDatabase = {
    ...db,
    prepare(sql) {
      const statement = db.prepare(sql);
      if (MEMBER_CAPTURE.test(sql)) {
        return {
          ...statement,
          async get(...parameters) {
            const principal = await statement.get(...parameters);
            expect(parameters).toEqual([FIX.workspace, FIX.member]);
            expect(principal).toEqual({ role: "member", authorization_epoch: 1 });
            captured++;
            return principal;
          },
        };
      }
      if (!STATUS_SOURCE.test(sql)) return statement;
      const cut = async () => {
        expect(captured).toBe(1);
        expect(fired).toBe(false);
        fired = true;
        await change();
        await foreignKeys(db);
        afterChange = await canonicalSnapshot(db);
        budgetsAfterChange = await httpBudgets(db);
      };
      return {
        ...statement,
        async get(...parameters) {
          await cut();
          return statement.get(...parameters);
        },
        async all(...parameters) {
          await cut();
          return statement.all(...parameters);
        },
      };
    },
  };
  return {
    database,
    async unchangedAfterCut() {
      expect(captured).toBe(1);
      expect(fired).toBe(true);
      expect(afterChange).toBeDefined();
      expect(budgetsAfterChange).toBeDefined();
      expect.soft(await canonicalSnapshot(db)).toEqual(afterChange);
      expect
        .soft(await httpBudgets(db), "post-cut status GET HTTP budgets remain unchanged")
        .toEqual(budgetsAfterChange);
      await foreignKeys(db);
    },
  };
}

async function removeSyntheticMember(db: SqlDatabase) {
  await db
    .prepare("DELETE FROM project_access WHERE workspace_id=? AND human_id=?")
    .run(FIX.workspace, FIX.member);
  expect(
    (
      await db
        .prepare("DELETE FROM workspace_members WHERE workspace_id=? AND human_id=?")
        .run(FIX.workspace, FIX.member)
    ).changes,
  ).toBe(1);
}

describe("mounted GitHub status delivery", () => {
  it.each(["owner", "member"] as const)(
    "keeps useful ordered workspace-wide status for %s without a second-project grant",
    async (actor) => {
      const f = await fixture();
      await noReadEffects(f.db, async () => {
        const response = await f.request(actor);
        expect.soft(response.status).toBe(200);
        expect.soft(response.headers.get("cache-control")).toBe("no-store");
        expect.soft(await response.json()).toEqual({
          ok: true,
          installations: f.installations,
          links: f.links,
        });
      });
    },
  );

  it.each(["owner", "member"] as const)("keeps authorized empty status for %s", async (actor) => {
    const f = await fixture(false);
    await noReadEffects(f.db, async () => {
      const response = await f.request(actor);
      expect.soft(response.status).toBe(200);
      expect.soft(response.headers.get("cache-control")).toBe("no-store");
      expect.soft(await response.json()).toEqual({ ok: true, installations: [], links: [] });
    });
  });

  it("retains initial Reviewer rejection before status source access", async () => {
    const f = await fixture();
    let statusReads = 0;
    const db: SqlDatabase = {
      ...f.db,
      prepare(sql) {
        if (/\b(?:FROM|JOIN)\s+github_(?:app_installations|repository_links)\b/.test(sql)) {
          statusReads++;
        }
        return f.db.prepare(sql);
      },
    };
    await noReadEffects(f.db, async () => {
      const response = await f.request("reviewer", db);
      expect.soft(response.status).toBe(403);
      expect.soft(response.headers.get("cache-control")).toBe("no-store");
      expect
        .soft(await response.json())
        .toEqual({ error: "forbidden", message: "role not permitted" });
    });
    expect(statusReads).toBe(0);
  });

  it.each(
    ["epoch", "removal", "demotion"].flatMap((loss) => [
      { loss, populated: true },
      { loss, populated: false },
    ]),
  )(
    "denies late $loss after the first membership capture (populated=$populated)",
    async ({ loss, populated }) => {
      const f = await fixture(populated);
      const cut = beforeStatusSelection(f.db, async () => {
        if (loss === "epoch") {
          expect(await bumpMemberEpoch(f.db, FIX.workspace, FIX.member)).toBe(2);
        } else if (loss === "removal") {
          await removeSyntheticMember(f.db);
        } else {
          // An isolated current-role fixture proves this ceiling independently of epoch loss.
          expect(
            (
              await f.db
                .prepare(
                  "UPDATE workspace_members SET role='reviewer' WHERE workspace_id=? AND human_id=?",
                )
                .run(FIX.workspace, FIX.member)
            ).changes,
          ).toBe(1);
        }
      });
      await unavailable(await f.request("member", cut.database));
      await cut.unchangedAfterCut();
    },
  );

  it("does not restore a synthetic reinstated membership at the still-revoked original epoch", async () => {
    const f = await fixture();
    const cut = beforeStatusSelection(f.db, async () => {
      await removeSyntheticMember(f.db);
      expect(
        (
          await f.db
            .prepare(
              "UPDATE workspace_authorization_epochs SET revoked_at=?,updated_at=? WHERE workspace_id=? AND human_id=? AND authorization_epoch=1",
            )
            .run(NOW, NOW, FIX.workspace, FIX.member)
        ).changes,
      ).toBe(1);
      // Fixture-only robustness: the real service reinstates with a new epoch, not this transition.
      await f.db
        .prepare(
          "INSERT INTO workspace_members (workspace_id,human_id,role,authorization_epoch,created_at) VALUES (?,?,'member',1,?)",
        )
        .run(FIX.workspace, FIX.member, NOW);
      await f.db
        .prepare("INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)")
        .run(FIX.workspace, FIX.projectA, FIX.member);
    });
    await unavailable(await f.request("member", cut.database));
    await cut.unchangedAfterCut();
  });

  it("returns both canonical arrays from the changed installation and link selection", async () => {
    const f = await fixture();
    const cut = beforeStatusSelection(f.db, async () => {
      expect(
        (
          await f.db
            .prepare(
              "UPDATE github_app_installations SET status='suspended',permissions_json=?,events_json=?,resource_version=3,updated_at=? WHERE workspace_id=? AND installation_id='1002'",
            )
            .run(
              JSON.stringify({ metadata: "read" }),
              JSON.stringify(["installation"]),
              NOW,
              FIX.workspace,
            )
        ).changes,
      ).toBe(1);
      expect(
        (
          await f.db
            .prepare(
              "UPDATE github_repository_links SET default_branch='release',resource_version=2 WHERE workspace_id=? AND id=?",
            )
            .run(FIX.workspace, f.linkA)
        ).changes,
      ).toBe(1);
    });
    const response = await f.request("member", cut.database);
    expect.soft(response.status).toBe(200);
    expect.soft(response.headers.get("cache-control")).toBe("no-store");
    expect.soft(await response.json()).toEqual({
      ok: true,
      installations: f.installations.map((row) =>
        row.installation_id === "1002"
          ? {
              ...row,
              status: "suspended",
              permissions: { metadata: "read" },
              events: ["installation"],
              resource_version: 3,
            }
          : row,
      ),
      links: f.links.map((row) =>
        row.link_id === f.linkA ? { ...row, default_branch: "release", resource_version: 2 } : row,
      ),
    });
    await cut.unchangedAfterCut();
  });
});

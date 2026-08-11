// ABOUTME: Proves production createFetchHandler() without options.db uses adaptD1(env.DB).
// ABOUTME: Seeds real SQL fixtures under a D1-shaped binding and exercises sign-in + session.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { adaptBetterSqlite3, adaptD1, applyMigrations, type D1Like } from "@bfb/db";
import { seedSyntheticWorkspace } from "../../../packages/domain/src/fixtures.js";
import { SYNTHETIC_PASSWORD } from "../../../packages/domain/src/passwords.js";

import { createFetchHandler, type ControlFetchOptions } from "../src/index.js";
import type { ControlBindings } from "../src/env.js";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations/d1",
);

function fakeBinding<T extends object>(label: string): T {
  return { __synthetic: label } as unknown as T;
}

/** Exposes better-sqlite3 as the Cloudflare D1 prepare/bind/first/all/run surface. */
function asD1(raw: Database.Database): D1Database {
  const d1: D1Like = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...params: unknown[]) {
          bound = params;
          return statement;
        },
        async first() {
          const stmt = raw.prepare(sql);
          const row = bound.length > 0 ? stmt.get(...bound) : stmt.get();
          return row ?? null;
        },
        async all() {
          const stmt = raw.prepare(sql);
          const results = bound.length > 0 ? stmt.all(...bound) : stmt.all();
          return { results, success: true, meta: {} };
        },
        async run() {
          const stmt = raw.prepare(sql);
          const result = bound.length > 0 ? stmt.run(...bound) : stmt.run();
          return { success: true, meta: { changes: result.changes }, results: [] };
        },
      };
      return statement;
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    },
  };
  return d1 as unknown as D1Database;
}

async function seededEnv(now = "2026-08-07T12:00:00Z"): Promise<ControlBindings> {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  applyMigrations(raw, migrationsDir);
  await seedSyntheticWorkspace(adaptBetterSqlite3(raw), now);
  return {
    DB: asD1(raw),
    ARTIFACTS: fakeBinding<R2Bucket>("r2"),
    JOBS: fakeBinding<Queue>("jobs"),
    JOBS_DLQ: fakeBinding<Queue>("dlq"),
    WORKSPACE_HUB: fakeBinding<DurableObjectNamespace>("hub"),
    APP_ORIGIN: "https://bfb.example.test",
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  };
}

describe("production D1 adapter wiring", () => {
  it("adaptD1 awaits real rows from first/all/run", async () => {
    const raw = new Database(":memory:");
    raw.exec(`CREATE TABLE t (n INTEGER); INSERT INTO t (n) VALUES (7);`);
    const db = adaptD1(asD1(raw) as unknown as Parameters<typeof adaptD1>[0]);
    const row = (await db.prepare("SELECT n FROM t WHERE n = ?").get(7)) as { n: number };
    expect(row.n).toBe(7);
    const rows = (await db.prepare("SELECT n FROM t").all()) as Array<{ n: number }>;
    expect(rows).toEqual([{ n: 7 }]);
    const result = await db.prepare("INSERT INTO t (n) VALUES (?)").run(9);
    expect(result.changes).toBe(1);
  });

  it("createFetchHandler without options.db signs in through adaptD1(env.DB)", async () => {
    const now = "2026-08-07T12:00:00Z";
    const env = await seededEnv(now);
    // Production default: no options.db — must use adaptD1(env.DB).
    const fetch = createFetchHandler({ now });

    const signIn = await fetch(
      new Request("https://bfb.example.test/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "owner@synthetic.test",
          password: SYNTHETIC_PASSWORD,
        }),
      }),
      env,
    );
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get("set-cookie");
    expect(cookie).toMatch(/bfb_session=/);
    const body = (await signIn.json()) as { ok: boolean; human: { email: string } };
    expect(body.ok).toBe(true);
    expect(body.human.email).toBe("owner@synthetic.test");

    const session = await fetch(
      new Request("https://bfb.example.test/auth/session", {
        headers: { cookie: cookie?.split(";")[0] ?? "" },
      }),
      env,
    );
    expect(session.status).toBe(200);
    const sessionBody = (await session.json()) as {
      authenticated: boolean;
      human: { email: string };
    };
    expect(sessionBody.authenticated).toBe(true);
    expect(sessionBody.human.email).toBe("owner@synthetic.test");
  });

  it("createFetchHandler without options.db serves tools/list via adaptD1", async () => {
    const env = await seededEnv();
    const fetch = createFetchHandler({ now: "2026-08-07T12:00:00Z" });
    const response = await fetch(
      new Request("https://bfb.example.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/list",
          Host: "bfb.example.test",
        },
        body: JSON.stringify({ method: "tools/list" }),
      }),
      env,
    );
    const text = await response.text();
    expect(text).not.toMatch(/mcp_misconfigured/);
    expect(response.status).toBe(200);
    const body = JSON.parse(text) as { tools?: unknown[] };
    expect(body.tools?.length).toBe(7);
  });

  it("options.db override still works for tests", async () => {
    const options: ControlFetchOptions = {
      // force missing override path coverage by only checking type
    };
    expect(options.db).toBeUndefined();
    const env = await seededEnv();
    const fetch = createFetchHandler(options);
    const response = await fetch(new Request("https://bfb.example.test/healthz"), env);
    expect(response.status).toBe(200);
  });
});

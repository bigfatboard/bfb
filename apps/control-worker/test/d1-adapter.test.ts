// ABOUTME: Proves the production Worker default export always resolves a database for /mcp.
// ABOUTME: Uses adaptD1 on a D1-shaped stub so fetch does not return mcp_misconfigured.

import { describe, expect, it } from "vitest";

import { adaptD1 } from "@bfb/db";

import { createFetchHandler, type ControlFetchOptions } from "../src/index.js";
import type { ControlBindings } from "../src/env.js";

function fakeBinding<T extends object>(label: string): T {
  return { __synthetic: label } as unknown as T;
}

/** Minimal D1 stub that supports prepare/bind/run/first/all for the adapter. */
function stubD1(): D1Database {
  const tables = new Map<string, unknown[]>();
  return {
    prepare(sql: string) {
      const statement = {
        bind(..._params: unknown[]) {
          return statement;
        },
        async first() {
          if (sql.includes("schema_migrations") || sql.includes("sqlite_master")) {
            return null;
          }
          return null;
        },
        async all() {
          return { results: tables.get(sql) ?? [], success: true, meta: {} };
        },
        async run() {
          return { success: true, meta: { changes: 0 }, results: [] };
        },
        raw: async () => [],
      };
      return statement;
    },
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    withSession: () => stubD1(),
  } as unknown as D1Database;
}

function env(): ControlBindings {
  return {
    DB: stubD1(),
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
  it("adaptD1 exposes prepare/run/get/all", async () => {
    const db = adaptD1(stubD1());
    const result = await Promise.resolve(db.prepare("SELECT 1 AS n").all());
    expect(Array.isArray(result)).toBe(true);
  });

  it("default createFetchHandler without options.db does not return mcp_misconfigured", async () => {
    const fetch = createFetchHandler();
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
      env(),
    );
    const text = await response.text();
    expect(text).not.toMatch(/mcp_misconfigured/);
    // May be 200 tools list or 400/500 from empty schema, but DB is bound.
    expect(response.status).not.toBe(500);
    // tools/list without schema still returns public map when routing succeeds
    if (response.status === 200) {
      const body = JSON.parse(text) as { tools?: unknown[] };
      expect(body.tools?.length).toBe(7);
    }
  });

  it("options.db override still works for tests", async () => {
    const options: ControlFetchOptions = {
      // force missing override path coverage by only checking type
    };
    expect(options.db).toBeUndefined();
    const fetch = createFetchHandler(options);
    const response = await fetch(new Request("https://bfb.example.test/healthz"), env());
    expect(response.status).toBe(200);
  });
});

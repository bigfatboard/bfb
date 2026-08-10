// ABOUTME: Structurally validates wrangler configs for DO SQLite exports and run_worker_first.
// ABOUTME: Reads the real committed toml files rather than re-encoding expected content.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(name: string): string {
  return readFileSync(path.join(root, name), "utf8");
}

describe("wrangler substrate configs", () => {
  it("declares sqlite durable object class without legacy migration tags", () => {
    const local = read("wrangler.toml");
    expect(local).toMatch(/new_sqlite_classes\s*=\s*\["WorkspaceHub"\]/);
    expect(local).not.toMatch(/new_classes\s*=/);
    expect(local).toMatch(/run_worker_first/);
    expect(local).toMatch(/\/mcp/);
    expect(local).toMatch(/binding = "DB"/);
    expect(local).toMatch(/binding = "ARTIFACTS"/);
    expect(local).toMatch(/binding = "JOBS"/);
    expect(local).toMatch(/binding = "JOBS_DLQ"/);
    expect(local).toMatch(/name = "WORKSPACE_HUB"/);
  });

  it("keeps isolated local staging and production configuration names", () => {
    expect(read("wrangler.toml")).toMatch(/name = "bfb-control-local"/);
    expect(read("wrangler.staging.toml")).toMatch(/name = "bfb-control-staging"/);
    expect(read("wrangler.production.toml")).toMatch(/name = "bfb-control"/);
  });
});

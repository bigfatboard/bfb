// ABOUTME: Structurally validates wrangler configs for DO SQLite exports and run_worker_first.
// ABOUTME: Reads the real committed toml files rather than re-encoding expected content.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RUN_WORKER_FIRST_GLOBS } from "../src/env.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(name: string): string {
  return readFileSync(path.join(root, name), "utf8");
}

function extractRunWorkerFirst(toml: string): string[] {
  const match = toml.match(/run_worker_first\s*=\s*\[([^\]]*)\]/s);
  if (!match) {
    throw new Error("run_worker_first missing");
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

const configs = ["wrangler.toml", "wrangler.staging.toml", "wrangler.production.toml"] as const;

describe("wrangler substrate configs", () => {
  it("declares sqlite durable object class without legacy migration tags on every env", () => {
    for (const name of configs) {
      const body = read(name);
      expect(body).toMatch(/new_sqlite_classes\s*=\s*\["WorkspaceHub"\]/);
      expect(body).not.toMatch(/new_classes\s*=/);
      expect(body).toMatch(/binding = "DB"/);
      expect(body).toMatch(/binding = "ARTIFACTS"/);
      expect(body).toMatch(/binding = "JOBS"/);
      expect(body).toMatch(/binding = "JOBS_DLQ"/);
      expect(body).toMatch(/name = "WORKSPACE_HUB"/);
      expect(body).toMatch(/class_name = "WorkspaceHub"/);
      expect(body).toMatch(/migrations_dir = "\.\.\/\.\.\/migrations\/d1"/);
    }
  });

  it("keeps isolated local staging and production configuration names", () => {
    expect(read("wrangler.toml")).toMatch(/name = "bfb-control-local"/);
    expect(read("wrangler.staging.toml")).toMatch(/name = "bfb-control-staging"/);
    expect(read("wrangler.production.toml")).toMatch(/name = "bfb-control"/);
  });

  it("includes Worker-first OAuth globs so SPA cannot shadow /oauth/*", () => {
    for (const name of configs) {
      const globs = extractRunWorkerFirst(read(name));
      expect(globs).toContain("/oauth");
      expect(globs).toContain("/oauth/*");
      for (const required of RUN_WORKER_FIRST_GLOBS) {
        expect(globs).toContain(required);
      }
    }
  });
});

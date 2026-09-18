// ABOUTME: Structurally validates wrangler configs for DO SQLite exports and run_worker_first.
// ABOUTME: Reads the real committed toml files rather than re-encoding expected content.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RUN_WORKER_FIRST_GLOBS, validateControlEnv, type ControlBindings } from "../src/env.js";

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

function extractVariable(toml: string, name: string): string {
  const match = toml.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"$`, "m"));
  if (!match?.[1]) {
    throw new Error(`${name} missing`);
  }
  return match[1];
}

function fakeBinding<T extends object>(label: string): T {
  return { __synthetic: label } as unknown as T;
}

function bindingsFromConfig(toml: string): ControlBindings {
  return {
    DB: fakeBinding<D1Database>("db"),
    ARTIFACTS: fakeBinding<R2Bucket>("r2"),
    ASSETS: fakeBinding<Fetcher>("assets"),
    JOBS: fakeBinding<Queue>("jobs"),
    JOBS_DLQ: fakeBinding<Queue>("jobs-dlq"),
    WORKSPACE_HUB: fakeBinding<DurableObjectNamespace>("workspace-hub"),
    APP_ORIGIN: extractVariable(toml, "APP_ORIGIN"),
    ARTIFACT_ORIGIN: extractVariable(toml, "ARTIFACT_ORIGIN"),
    LAUNCH_ORIGIN: extractVariable(toml, "LAUNCH_ORIGIN"),
    JURISDICTION: extractVariable(toml, "JURISDICTION"),
    ENVIRONMENT: extractVariable(toml, "ENVIRONMENT"),
  };
}

const configs = ["wrangler.toml", "wrangler.staging.toml", "wrangler.production.toml"] as const;
const spikeConfig = "wrangler.spike.toml";
const artifactRoot = path.resolve(root, "../artifact-worker");
const artifactConfigs = [
  "wrangler.toml",
  "wrangler.staging.toml",
  "wrangler.production.toml",
] as const;

describe("wrangler substrate configs", () => {
  it("declares the SQLite Durable Object export without legacy migrations on every env", () => {
    for (const name of configs) {
      const body = read(name);
      expect(body).toMatch(/\[exports\.WorkspaceHub\]/);
      expect(body).toMatch(/type\s*=\s*"durable-object"/);
      expect(body).toMatch(/storage\s*=\s*"sqlite"/);
      expect(body).not.toMatch(/\[\[migrations\]\]/);
      expect(body).not.toMatch(/\btag\s*=/);
      expect(body).toMatch(/binding = "DB"/);
      expect(body).toMatch(/binding = "ARTIFACTS"/);
      expect(body).toMatch(/binding = "ASSETS"/);
      expect(body).toMatch(/binding = "JOBS"/);
      expect(body).toMatch(/binding = "JOBS_DLQ"/);
      expect(body).toMatch(/name = "WORKSPACE_HUB"/);
      expect(body).toMatch(/class_name = "WorkspaceHub"/);
      expect(body).toMatch(/migrations_dir = "\.\.\/\.\.\/migrations\/d1"/);
      expect(body).toMatch(/\[triggers\]/);
      expect(body).toMatch(/crons\s*=\s*\["\*\/5 \* \* \* \*"\]/);
      // X01 owns the only queue consumer: the notification queue with its
      // matching DLQ. Later packages add their own distinct queues/consumers.
      const consumers = [
        ...body.matchAll(
          /\[\[queues\.consumers\]\]\s*\nqueue = "([^"]+)"\s*\nmax_batch_size = 10\s*\nmax_batch_timeout = 5\s*\nmax_retries = 5\s*\ndead_letter_queue = "([^"]+)"/g,
        ),
      ];
      expect(consumers.length).toBe(1);
      expect(consumers[0]?.[1]).toMatch(/^bfb-notify(-staging)?(-local)?$/);
      expect(consumers[0]?.[2]).toBe(`${consumers[0]?.[1]?.replace(/-notify/, "-notify-dlq")}`);
      expect(body).toMatch(/binding = "NOTIFY_JOBS"/);
      expect(body).toMatch(/binding = "NOTIFY_DLQ"/);
    }
  });

  it("keeps isolated local staging and production configuration names", () => {
    const localControl = read("wrangler.toml");
    const localArtifact = readFileSync(path.join(artifactRoot, "wrangler.toml"), "utf8");
    expect(localControl).toMatch(/name = "bfb-control-local"/);
    expect(localControl).toMatch(/APP_ORIGIN = "http:\/\/bfb\.localhost:8787"/);
    expect(localControl).toMatch(/port = 8787/);
    expect(localControl).toMatch(/inspector_port = 9229/);
    expect(read("wrangler.staging.toml")).toMatch(/name = "bfb-control-staging"/);
    expect(read("wrangler.production.toml")).toMatch(/name = "bfb-control"/);
    expect(localArtifact).toMatch(/name = "bfb-artifact-local"/);
    expect(localArtifact).toMatch(/ARTIFACT_ORIGIN = "http:\/\/artifacts\.bfb\.localhost:8788"/);
    expect(localArtifact).toMatch(/port = 8788/);
    expect(localArtifact).toMatch(/inspector_port = 9230/);
    expect(readFileSync(path.join(artifactRoot, "wrangler.staging.toml"), "utf8")).toMatch(
      /name = "bfb-artifact-staging"/,
    );
    expect(readFileSync(path.join(artifactRoot, "wrangler.production.toml"), "utf8")).toMatch(
      /name = "bfb-artifact"/,
    );
    for (const name of artifactConfigs) {
      const body = readFileSync(path.join(artifactRoot, name), "utf8");
      expect(body).toMatch(/binding = "ARTIFACTS"/);
      // V01: the Artifact Worker rechecks grants and records verified upload
      // metadata with conditional D1 batches, so it binds the shared D1 but
      // never dispatches through WORKSPACE_HUB (finalization owns the hub).
      expect(body).toMatch(/binding = "DB"/);
      expect(body).not.toMatch(/binding = "WORKSPACE_HUB"/);
    }
  });

  it("passes every environment's committed origins through runtime validation", () => {
    for (const name of configs) {
      const body = read(name);
      const validated = validateControlEnv(bindingsFromConfig(body));
      expect(validated.environment).toBe(extractVariable(body, "ENVIRONMENT"));
      expect(validated.origins.appOrigin).toBe(extractVariable(body, "APP_ORIGIN"));
      expect(validated.origins.artifactOrigin).toBe(extractVariable(body, "ARTIFACT_ORIGIN"));
      expect(validated.origins.launchOrigin).toBe(extractVariable(body, "LAUNCH_ORIGIN"));
    }
  });

  it("keeps the Better Auth runtime spike disposable and local", () => {
    const body = read(spikeConfig);
    expect(body).toMatch(/name = "bfb-substrate-spike-local"/);
    expect(body).toMatch(/main = "src\/substrate-spike\.ts"/);
    expect(body).toMatch(/port = 8790/);
    expect(body).toMatch(/inspector_port = 9232/);
    expect(body).toMatch(/binding = "DB"/);
    expect(body).toMatch(/name = "WORKSPACE_HUB"/);
    expect(body).toMatch(/\[exports\.WorkspaceHub\]/);
    expect(body).not.toMatch(/\[assets\]|\[triggers\]|\[\[queues\.|\[\[r2_buckets\]\]/);
    expect(body).not.toMatch(/ENVIRONMENT|APP_ORIGIN|ARTIFACT_ORIGIN|LAUNCH_ORIGIN/);
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

// ABOUTME: Verifies fixed real-pilot configuration and atomic first-owner capability initialization.
// ABOUTME: Uses migrated SQLite and private temporary inputs without fabricating users or sessions.

import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bootstrapCode, bootstrapSQL, signalPilotChild } from "./run.mjs";
import {
  artifactSecrets,
  controlSecrets,
  origins,
  pilotPaths,
  privateDirectory,
  privateFile,
  readSecrets,
  repoRoot,
  validateSecrets,
  workerArguments,
  wranglerEnvironment,
} from "./state.mjs";

const require = createRequire(join(repoRoot, "packages/db/package.json"));
const Database = require("better-sqlite3");

test("pilot starts only real Worker entries with the same durable local store and private secret files", () => {
  const paths = pilotPaths(join(realpathSync(tmpdir()), "bfb-pilot-unit"));
  for (const worker of ["control", "artifact"]) {
    const args = workerArguments(worker, paths);
    assert.ok(args.includes("--local"));
    assert.ok(args.includes(paths.data));
    assert.ok(args.includes("https"));
    assert.ok(args.includes(paths.certificate));
    assert.ok(args.some((arg) => arg.endsWith("wrangler.pilot.toml")));
    assert.ok(!args.some((arg) => arg.includes("tools/e2e") || arg.includes("--remote")));
  }
  assert.equal(new Set(Object.values(origins).map((origin) => new URL(origin).hostname)).size, 3);
  assert.throws(() => pilotPaths("/"));
  assert.throws(() => pilotPaths("relative"));
  assert.throws(() => pilotPaths(repoRoot), /outside the repository/);
  assert.throws(() => pilotPaths(join(repoRoot, "private-pilot")), /outside the repository/);
  assert.equal(wranglerEnvironment("/tmp/log").CLOUDFLARE_INCLUDE_PROCESS_ENV, "false");
  assert.equal(wranglerEnvironment("/tmp/log").GITHUB_CLIENT_SECRET, undefined);
});

test("private inputs reject public files and binding overrides; diagnostics never return values", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "bfb-pilot-inputs-")));
  try {
    const path = join(directory, "control.env");
    await writeFile(path, "GITHUB_CLIENT_ID=synthetic-public-id\n", { mode: 0o644 });
    await assert.rejects(privateFile(path));
    await rm(path);
    await writeFile(path, "APP_ORIGIN=https://foreign.test\n", { mode: 0o600 });
    await assert.rejects(readSecrets(path, controlSecrets), /undeclared/);
    const control = Object.fromEntries(controlSecrets.map((name) => [name, "x".repeat(32)]));
    control.BETTER_AUTH_SECRETS = "1:" + "x".repeat(32);
    validateSecrets(control, { [artifactSecrets[0]]: "y".repeat(32) });
    assert.throws(() =>
      validateSecrets(
        { ...control, BETTER_AUTH_SECRETS: "1:x" },
        { UPLOAD_ABUSE_SECRET: "y".repeat(32) },
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bootstrap initialization atomically guards the real migrated empty DB and never overwrites", async () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys=ON");
    const manifest = JSON.parse(
      await readFile(join(repoRoot, "migrations/d1/manifest.json"), "utf8"),
    );
    for (const migration of manifest.migrations)
      db.exec(await readFile(join(repoRoot, "migrations/d1", migration.file), "utf8"));
    const first = bootstrapSQL(
      "a".repeat(64),
      "2026-10-06T10:00:00.000Z",
      "2026-10-06T10:30:00.000Z",
    );
    db.exec(first);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bootstrap_state").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM workspaces").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM humans").get().n, 0);
    db.exec(bootstrapSQL("b".repeat(64), "2026-10-06T10:01:00.000Z", "2026-10-06T10:31:00.000Z"));
    assert.equal(
      db.prepare("SELECT secret_hash FROM bootstrap_state").get().secret_hash,
      "a".repeat(64),
    );
    db.exec(bootstrapSQL("a".repeat(64), "2026-10-06T10:02:00.000Z", "2026-10-06T10:32:00.000Z"));
    assert.equal(
      db.prepare("SELECT expires_at FROM bootstrap_state").get().expires_at,
      "2026-10-06T10:30:00.000Z",
    );
    db.exec("UPDATE bootstrap_state SET consumed_at='2026-10-06T10:02:00.000Z'");
    db.exec(first);
    assert.equal(
      db.prepare("SELECT consumed_at FROM bootstrap_state").get().consumed_at,
      "2026-10-06T10:02:00.000Z",
    );
    assert.throws(() =>
      bootstrapSQL("';private", "2026-10-06T10:00:00.000Z", "2026-10-06T10:30:00.000Z"),
    );
  } finally {
    db.close();
  }
});

test("bootstrap retry retains the same private operator code after an unknown outcome", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "bfb-pilot-bootstrap-")));
  try {
    const paths = pilotPaths(directory);
    const first = await bootstrapCode(paths);
    assert.match(first, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(await bootstrapCode(paths), first);
    assert.equal((await privateFile(paths.bootstrapCode)).trim(), first);
    await writeFile(paths.bootstrapCode, "invalid\n", { mode: 0o600 });
    await assert.rejects(bootstrapCode(paths), /nothing overwritten/);
    assert.equal(await privateFile(paths.bootstrapCode), "invalid\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shutdown skips completed and signal-exited child groups before escalation", (t) => {
  const signals = [];
  t.mock.method(process, "kill", (pid, signal) => signals.push({ pid, signal }));
  const child = { pid: 12345, exitCode: null, signalCode: null };
  signalPilotChild(child, "SIGTERM");
  child.signalCode = "SIGTERM";
  signalPilotChild(child, "SIGTERM");
  signalPilotChild(child, "SIGKILL");
  child.signalCode = null;
  child.exitCode = 0;
  signalPilotChild(child, "SIGKILL");
  assert.deepEqual(signals, [{ pid: -12345, signal: "SIGTERM" }]);
});

test("symlink ancestors cannot redirect pilot creation or secret reads into the repository", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "bfb-pilot-paths-")));
  try {
    const alias = join(directory, "repository-alias");
    await symlink(repoRoot, alias);
    const redirected = join(alias, ".pilot-symlink-regression");
    assert.throws(() => pilotPaths(redirected), /outside the repository/);
    await assert.rejects(privateDirectory(redirected), /outside the repository/);
    await assert.rejects(stat(redirected), { code: "ENOENT" });
    await assert.rejects(privateFile(join(alias, "package.json")), /outside the repository/);
    const safe = join(directory, "private-state");
    await privateDirectory(safe);
    const outsideAlias = join(directory, "outside-alias");
    await symlink(safe, outsideAlias);
    assert.throws(() => pilotPaths(join(outsideAlias, "new-state")), /without symlink ancestors/);
    await assert.rejects(
      privateDirectory(join(outsideAlias, "new-state")),
      /without symlink ancestors/,
    );
    await assert.rejects(stat(join(safe, "new-state")), { code: "ENOENT" });
    assert.equal(pilotPaths(safe).root, safe);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

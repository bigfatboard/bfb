// ABOUTME: Certifies the D02 delivery migration, evidence shape, and real-provider availability.
// ABOUTME: Runs no model and spends no budget; a live Codex turn needs explicit consent.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import Database from "better-sqlite3";

import {
  applyMigrationsForVerification,
  loadMigrationManifest,
  type MigrationDatabase,
} from "@bfb/db";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const execFileAsync = promisify(execFile);
const migrationsDir = resolve(root, "migrations/d1");

const manifest = loadMigrationManifest(migrationsDir);
assert.ok(
  manifest.migrations.some((entry) => entry.id === "0025_discussion_delivery"),
  "D02 delivery migration must be registered",
);

const db = new Database(":memory:");
const applied = applyMigrationsForVerification(db as unknown as MigrationDatabase, migrationsDir);
assert.equal(applied.status, "complete");
assert.ok(applied.head >= "0025_discussion_delivery", "D02 delivery migration must be applied");
for (const index of [
  "discussion_deliveries_d02_schedule",
  "discussion_turns_d02_schedule",
  "discussion_messages_d02_inputs",
]) {
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(index),
    { name: index },
  );
}
console.log(
  "D02_MIGRATION_OK empty database reaches 0025_discussion_delivery with delivery covering indexes",
);

try {
  const { stdout } = await execFileAsync("codex", ["--version"]);
  const version = stdout.trim().replace(/^codex-cli\s+/, "");
  if (/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    console.log(
      `D02_CODEX_OK installed codex-cli ${version}${version === "0.153.4" ? " matches the tested adapter version" : " differs from the tested 0.153.4; planning fixtures do not transfer"}`,
    );
  } else {
    console.log("D02_CODEX_UNAVAILABLE codex version output is unrecognized");
  }
} catch {
  console.log("D02_CODEX_UNAVAILABLE codex binary is not installed");
}

if (process.env["BFB_D02_CODEX_CONSENT"] === "1") {
  console.log(
    "D02_CODEX_LIVE_CONSENT live-turn consent is set; run the bounded experiment explicitly",
  );
} else {
  console.log(
    "D02_CODEX_LIVE_SKIPPED no live model turn without explicit consent; offline adapter evidence only",
  );
}

// ABOUTME: Verifies private pilot key creation without credential output or destructive rotation.
// ABOUTME: Covers invalid input, partial recovery and preservation of existing operator files.

import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { configurePilot, secretFile } from "./configure.mjs";
import { pilotPaths, readSecrets, controlSecrets } from "./state.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bfb-pilot-config-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return pilotPaths(root);
}

test("creates private keys and reuses them without prompting or rotation", async (t) => {
  const paths = await fixture(t);
  const answers = ["synthetic-client", "synthetic-secret"];
  const result = await configurePilot(paths, async () => answers.shift());
  assert.deepEqual(result, { configured: true, existing: false });
  const before = await readFile(paths.controlEnv);
  const artifact = await readFile(paths.artifactEnv);
  assert.equal((await stat(paths.controlEnv)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.artifactEnv)).mode & 0o777, 0o600);
  const values = await readSecrets(paths.controlEnv, controlSecrets);
  assert.equal(values.GITHUB_CLIENT_ID, "synthetic-client");
  assert.equal(values.GITHUB_CLIENT_SECRET, "synthetic-secret");
  assert.match(values.BETTER_AUTH_SECRETS, /^1:[A-Za-z0-9_-]{43}$/u);
  assert.match(values.AUTH_ABUSE_SECRET, /^[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(await configurePilot(paths, () => assert.fail("unexpected credential prompt")), {
    configured: true,
    existing: true,
  });
  assert.deepEqual(await readFile(paths.controlEnv), before);
  assert.deepEqual(await readFile(paths.artifactEnv), artifact);
  await unlink(paths.artifactEnv);
  await configurePilot(paths, () => assert.fail("partial recovery rotated OAuth/auth keys"));
  assert.deepEqual(await readFile(paths.controlEnv), before);
});

test("rejects missing or injectable OAuth input before writing any binding", async (t) => {
  for (const secret of ["", "synthetic\nEXTRA_BINDING=synthetic", 'synthetic"quote']) {
    const paths = await fixture(t);
    const answers = ["synthetic-client", secret];
    await assert.rejects(configurePilot(paths, async () => answers.shift()));
    await assert.rejects(stat(paths.controlEnv), { code: "ENOENT" });
    await assert.rejects(stat(paths.artifactEnv), { code: "ENOENT" });
  }
});

test("preserves malformed existing state rather than silently replacing it", async (t) => {
  const paths = await fixture(t);
  const prior = "AUTH_ABUSE_SECRET=synthetic-incomplete\n";
  await writeFile(paths.controlEnv, prior, { mode: 0o600 });
  await assert.rejects(configurePilot(paths, () => assert.fail("existing state must not prompt")));
  assert.equal(await readFile(paths.controlEnv, "utf8"), prior);
  await assert.rejects(stat(paths.artifactEnv), { code: "ENOENT" });
});

test("serialization rejects binding injection and supports ordinary base64 keys", () => {
  assert.equal(secretFile({ KEY: "1:abc+/=,2:def_-." }, ["KEY"]), "KEY=1:abc+/=,2:def_-.\n");
  assert.throws(() => secretFile({ KEY: "synthetic\nOTHER=yes" }, ["KEY"]));
});

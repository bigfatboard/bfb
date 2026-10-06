// ABOUTME: Checks generated pilot server certificates and preservation of private operator keys.
// ABOUTME: Proves generation does not install trust or overwrite missing, mismatched or symlinked state.

import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { pilotPaths } from "./state.mjs";
import { generatePilotCertificate, verifyPilotCertificate } from "./tls.mjs";

test("generates server-only SAN certificate once and refuses incomplete or symlinked keys", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bfb-pilot-tls-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = pilotPaths(root);
  const first = await generatePilotCertificate(paths);
  assert.equal(first.existing, false);
  assert.match(first.fingerprint, /^[A-F0-9:]+$/u);
  const originalCertificate = await readFile(paths.certificate);
  const originalKey = await readFile(paths.certificateKey);
  assert.equal((await stat(paths.certificate)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.certificateKey)).mode & 0o777, 0o600);
  assert.deepEqual(await generatePilotCertificate(paths), { ...first, existing: true });
  assert.deepEqual(await readFile(paths.certificate), originalCertificate);
  assert.deepEqual(await readFile(paths.certificateKey), originalKey);
  await unlink(paths.certificateKey);
  await assert.rejects(generatePilotCertificate(paths), { code: "ENOENT" });
  assert.deepEqual(await readFile(paths.certificate), originalCertificate);
  await symlink(paths.certificate, paths.certificateKey);
  await assert.rejects(verifyPilotCertificate(paths));
  await assert.rejects(generatePilotCertificate(paths));
  assert.deepEqual(await readFile(paths.certificate), originalCertificate);
});

test("reused certificates cannot broaden local trust to external names or client authentication", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bfb-pilot-tls-scope-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = pilotPaths(root);
  await generatePilotCertificate(paths);
  for (const [extraName, usage] of [
    [",DNS:external.example", "serverAuth"],
    ["", "serverAuth,clientAuth"],
  ]) {
    const config = join(root, "wider.cnf");
    const certificate = join(root, "wider.pem");
    await writeFile(
      config,
      `[req]\nprompt=no\ndistinguished_name=subject\nx509_extensions=server\n[subject]\nCN=Synthetic scope test\n[server]\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=${usage}\nsubjectAltName=DNS:localhost,DNS:artifacts.localhost,DNS:launch.localhost${extraName}\n`,
      { mode: 0o600 },
    );
    const result = spawnSync(
      "/usr/bin/openssl",
      [
        "req",
        "-new",
        "-x509",
        "-key",
        paths.certificateKey,
        "-config",
        config,
        "-days",
        "1",
        "-out",
        certificate,
      ],
      { stdio: "pipe", timeout: 30_000 },
    );
    assert.equal(result.status, 0);
    await chmod(certificate, 0o600);
    await assert.rejects(
      verifyPilotCertificate({ ...paths, certificate }),
      /only the three fixed loopback names and server authentication/u,
    );
  }
  await verifyPilotCertificate(paths);
});

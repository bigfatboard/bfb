// ABOUTME: Exercises the stock persistent HTTPS pilot Workers with isolated private configuration.
// ABOUTME: Checks empty real-auth state, bootstrap reconciliation and durable D1/R2 without fake sessions.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertPinnedWrangler,
  origins,
  pilotPaths,
  privateDirectory,
  privateFile,
  repoRoot,
  wranglerEnvironment,
} from "./state.mjs";
import { verifyPilotCertificate } from "./tls.mjs";

function request(origin, path, method = "GET") {
  return new Promise((resolve, reject) => {
    const operation = https.request(
      new URL(path, origin),
      { method, timeout: 5_000 },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk.toString("utf8");
          if (Buffer.byteLength(body) > 65_536)
            operation.destroy(new Error("Smoke response exceeds its bound."));
        });
        response.on("end", () => resolve({ status: response.statusCode, body }));
      },
    );
    operation.on("timeout", () => operation.destroy(new Error("Smoke request timed out.")));
    operation.on("error", reject);
    operation.end();
  });
}

const root = await realpath(await mkdtemp(join(tmpdir(), "bfb-pilot-smoke-")));
const paths = pilotPaths(root);
await privateDirectory(paths.logs);
await privateDirectory(join(paths.root, "tls"));
const operatorTLS = pilotPaths();
await verifyPilotCertificate(operatorTLS);
for (const key of ["certificate", "certificateKey"]) {
  await copyFile(operatorTLS[key], paths[key]);
  await chmod(paths[key], 0o600);
}
await writeFile(
  paths.controlEnv,
  `BETTER_AUTH_SECRETS=1:${randomBytes(32).toString("base64url")}\nAUTH_ABUSE_SECRET=${randomBytes(32).toString("base64url")}\nGITHUB_CLIENT_ID=isolated-smoke-not-an-oauth-app\nGITHUB_CLIENT_SECRET=${randomBytes(32).toString("base64url")}\n`,
  { flag: "wx", mode: 0o600 },
);
await writeFile(
  paths.artifactEnv,
  `UPLOAD_ABUSE_SECRET=${randomBytes(32).toString("base64url")}\n`,
  { flag: "wx", mode: 0o600 },
);
console.log(
  JSON.stringify({ smoke_state: root, logs: paths.logs, synthetic_credentials_only: true }),
);

let attempt = 0;
function command(
  executable,
  args,
  name,
  environment = wranglerEnvironment(join(paths.logs, `${name}.wrangler.log`)),
) {
  const log = createWriteStream(join(paths.logs, `${name}.log`), { flags: "wx", mode: 0o600 });
  const child = spawn(executable, args, {
    cwd: repoRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
    if (Buffer.byteLength(output) > 65_536) child.kill("SIGKILL");
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      log.end();
      reject(error);
    });
    child.once("close", (code) => log.end(() => resolve({ code, output })));
  });
  return { child, completion };
}

const env = {
  ...wranglerEnvironment(join(paths.logs, "supervisor.wrangler.log")),
  BFB_PILOT_STATE_DIR: root,
  NODE_USE_SYSTEM_CA: "1",
};
const pilot = (action) =>
  command(
    process.execPath,
    ["--use-system-ca", "tools/pilot/run.mjs", action],
    `${action}-${++attempt}`,
    env,
  );
const wrangler = await assertPinnedWrangler();
async function localD1(query) {
  const operation = command(
    wrangler,
    [
      "d1",
      "execute",
      "DB",
      "--local",
      "--config",
      "apps/control-worker/wrangler.pilot.toml",
      "--persist-to",
      paths.data,
      "--command",
      query,
      "--json",
    ],
    `query-${++attempt}`,
  );
  const { code, output } = await operation.completion;
  assert.equal(code, 0, "Local D1 observation failed; see its private log.");
  return JSON.parse(output).flatMap((result) => result.results ?? []);
}

let supervisor;
async function start() {
  for (const port of [8787, 8788]) {
    const occupied = await new Promise((resolve) => {
      const probe = net.createConnection({ host: "127.0.0.1", port });
      probe.setTimeout(1_000, () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });
    assert.equal(
      occupied,
      false,
      `Pilot port ${port} is already occupied; no existing process was stopped.`,
    );
  }
  supervisor = pilot("start");
  supervisor.completion.then(({ code }) => {
    if (code !== 0) console.error(`Pilot exited ${code}; inspect ${paths.logs}.`);
  });
  for (let retry = 0; retry < 90; retry++) {
    if (supervisor.child.exitCode !== null)
      throw new Error("Pilot startup exited before readiness.");
    const ready = await Promise.all(
      [origins.app, origins.artifact, origins.launch].map((origin) =>
        request(origin, "/healthz").then(
          (response) => response.status === 200,
          () => false,
        ),
      ),
    );
    if (ready.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Persistent Worker readiness timed out.");
}
async function stop() {
  if (!supervisor || supervisor.child.exitCode !== null) return;
  const control = await pilot("stop").completion;
  assert.equal(control.code, 0, "Private supervisor stop failed.");
  const result = await supervisor.completion;
  assert.equal(result.code, 0);
  supervisor = undefined;
}

try {
  const check = await pilot("preflight").completion;
  assert.equal(check.code, 0, "Isolated pilot preflight failed.");
  await start();
  const session = await request(origins.app, "/auth/session");
  assert.equal(session.status, 401);
  assert.equal((await request(origins.app, "/api/v1/workspaces")).status, 401);
  for (const path of ["/__test/session/owner", "/__test/command"]) {
    // Stock asset dispatch rejects unknown POSTs as 405, or Worker-first paths as 404.
    assert.ok([404, 405].includes((await request(origins.app, path, "POST")).status));
  }
  assert.equal(
    (
      await request(
        origins.launch,
        "/runner/workspaces/01K00000000000000000000009/runners/01K00000000000000000000009/wake/redeem",
        "POST",
      )
    ).status,
    403,
  );
  const manifest = JSON.parse(
    await readFile(join(repoRoot, "migrations/d1/manifest.json"), "utf8"),
  );
  const migrations = await localD1("SELECT name FROM d1_migrations ORDER BY id");
  assert.equal(migrations.at(-1).name, manifest.migrations.at(-1).file);
  const empty = await localD1(
    "SELECT (SELECT COUNT(*) FROM workspaces) AS workspaces, (SELECT COUNT(*) FROM humans) AS humans, (SELECT COUNT(*) FROM better_auth_sessions) AS sessions",
  );
  assert.deepEqual(empty, [{ workspaces: 0, humans: 0, sessions: 0 }]);
  console.log("PILOT_REAL_AUTH_EMPTY_STATE_OK");

  // Lose only the operator-facing result after the actual INSERT has committed.
  // A second independent CLI invocation must reconcile, not rotate the capability.
  const first = await pilot("bootstrap").completion;
  assert.equal(first.code, 0);
  const codeBefore = await privateFile(paths.bootstrapCode);
  const original = await localD1("SELECT expires_at, consumed_at FROM bootstrap_state");
  const retry = await pilot("bootstrap").completion;
  assert.equal(retry.code, 0);
  assert.equal(await privateFile(paths.bootstrapCode), codeBefore);
  assert.deepEqual(await localD1("SELECT expires_at, consumed_at FROM bootstrap_state"), original);
  console.log("PILOT_BOOTSTRAP_COMMITTED_RESULT_LOSS_RETRY_OK");

  const content = Buffer.from("BFB isolated persistent R2 infrastructure smoke\n");
  const input = join(root, "r2-input.txt"),
    output = join(root, "r2-output.txt");
  await writeFile(input, content, { flag: "wx", mode: 0o600 });
  const base = [
    "--local",
    "--config",
    "apps/artifact-worker/wrangler.pilot.toml",
    "--persist-to",
    paths.data,
  ];
  assert.equal(
    (
      await command(
        wrangler,
        ["r2", "object", "put", "bfb-artifacts-pilot/isolated-smoke", ...base, "--file", input],
        `r2-put-${++attempt}`,
      ).completion
    ).code,
    0,
  );
  await stop();
  await start();
  assert.deepEqual(await localD1("SELECT expires_at, consumed_at FROM bootstrap_state"), original);
  assert.equal(await privateFile(paths.bootstrapCode), codeBefore);
  assert.equal((await request(origins.app, "/auth/session")).status, 401);
  assert.equal(
    (
      await command(
        wrangler,
        ["r2", "object", "get", "bfb-artifacts-pilot/isolated-smoke", ...base, "--file", output],
        `r2-get-${++attempt}`,
      ).completion
    ).code,
    0,
  );
  assert.deepEqual(await readFile(output), content);
  await stop();
  console.log("PILOT_PERSISTENT_D1_R2_RESTART_OK");
} finally {
  if (supervisor?.child.exitCode === null) {
    await stop().catch(async () => {
      supervisor.child.kill("SIGTERM");
      await supervisor.completion;
    });
  }
  // Retain this invocation's private state and all complete logs for inspection.
  console.log(JSON.stringify({ retained_private_smoke_state: root }));
}

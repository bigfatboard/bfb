// ABOUTME: Supervises persistent production Worker processes for a real-auth localhost pilot.
// ABOUTME: Migrates only local D1, checks HTTPS health, and stops only its private supervisor instance.

import { spawn } from "node:child_process";
import { randomBytes, createHmac } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, open, readFile, unlink, writeFile } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  artifactSecrets,
  assertPinnedWrangler,
  controlSecrets,
  origins,
  pilotPaths,
  privateDirectory,
  privateFile,
  readSecrets,
  repoRoot,
  secretChecks,
  validateSecrets,
  workerArguments,
  wranglerEnvironment,
} from "./state.mjs";
import { verifyPilotCertificate } from "./tls.mjs";

async function preflight(paths) {
  const checks = [];
  let control, artifact;
  for (const [worker, file, names] of [
    ["control", paths.controlEnv, controlSecrets],
    ["artifact", paths.artifactEnv, artifactSecrets],
  ]) {
    try {
      const values = await readSecrets(file, names);
      checks.push({ check: `${worker}_bindings`, bindings: secretChecks(values, names) });
      if (worker === "control") control = values;
      else artifact = values;
    } catch {
      checks.push({ check: `${worker}_bindings`, valid: false });
    }
  }
  if (control && artifact) {
    try {
      validateSecrets(control, artifact);
      checks.push({ check: "auth_configuration", valid: true });
    } catch (error) {
      checks.push({ check: "auth_configuration", valid: false, message: error.message });
    }
  }
  try {
    await verifyPilotCertificate(paths);
    checks.push({ check: "https_certificate", valid: true });
  } catch {
    checks.push({ check: "https_certificate", valid: false });
  }
  try {
    await assertPinnedWrangler();
    await readFile(join(repoRoot, "apps/web/dist/index.html"));
    checks.push({ check: "built_runtime", valid: true });
  } catch {
    checks.push({ check: "built_runtime", valid: false });
  }
  return {
    ok: checks.every(
      (check) =>
        check.valid !== false &&
        (!check.bindings || check.bindings.every((binding) => binding.present)),
    ),
    origins,
    checks,
  };
}

async function health(origin, paths) {
  await verifyPilotCertificate(paths);
  return await new Promise((resolve, reject) => {
    const request = https.get(new URL("/healthz", origin), { timeout: 5_000 }, (response) => {
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 4_096) request.destroy(new Error("Health response exceeds its bound."));
      });
      response.on("end", () => resolve(response.statusCode === 200));
    });
    request.on("timeout", () => request.destroy(new Error("Health check timed out.")));
    request.on("error", reject);
  });
}

async function requireFreePorts() {
  for (const origin of [origins.app, origins.artifact]) {
    const port = Number(new URL(origin).port);
    for (const host of ["127.0.0.1", "::1"]) {
      const occupied = await new Promise((resolve, reject) => {
        const probe = net.createConnection({ host, port });
        probe.setTimeout(1_000, () => {
          probe.destroy();
          reject(new Error("Pilot port check timed out."));
        });
        probe.once("connect", () => {
          probe.destroy();
          resolve(true);
        });
        probe.once("error", (error) => {
          if (error.code === "ECONNREFUSED") resolve(false);
          else reject(new Error("Pilot port availability could not be confirmed."));
        });
      });
      if (occupied)
        throw new Error(`Pilot port ${port} is already occupied; no existing process was stopped.`);
    }
  }
}

function loggedProcess(command, args, logs, name) {
  const output = createWriteStream(join(logs, `${name}.log`), { flags: "ax", mode: 0o600 });
  const child = spawn(command, args, {
    cwd: repoRoot,
    detached: true,
    env: wranglerEnvironment(join(logs, `${name}.wrangler.log`)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  const completion = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      output.end();
      reject(error);
    });
    child.once("close", (code) => output.end(() => resolve(code)));
  });
  return { child, completion };
}

export function signalPilotChild(child, signal) {
  // Node records signal termination in signalCode, leaving exitCode null.
  // Never address a retired process group whose numeric ID may be reused.
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* Already exited. */
  }
}

async function migrate(paths, logs, children) {
  const wrangler = await assertPinnedWrangler();
  const operation = loggedProcess(
    wrangler,
    [
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--config",
      join(repoRoot, "apps/control-worker/wrangler.pilot.toml"),
      "--persist-to",
      paths.data,
    ],
    logs,
    "migrations",
  );
  children.push(operation);
  if ((await operation.completion) !== 0)
    throw new Error("Local migrations failed; see the private migrations log.");
}

export async function startPilot(paths = pilotPaths()) {
  await privateDirectory(paths.root);
  const check = await preflight(paths);
  if (!check.ok) {
    console.log(JSON.stringify(check, null, 2));
    throw new Error("Pilot preflight failed; no Worker started.");
  }
  await requireFreePorts();
  const instance = randomBytes(16).toString("hex");
  const lock = await open(paths.runtime, "wx", 0o600);
  const logs = join(
    paths.logs,
    `${new Date().toISOString().replaceAll(":", "-")}-${instance.slice(0, 8)}`,
  );
  const runtime = {
    schema_version: 1,
    instance,
    pid: process.pid,
    started_at: new Date().toISOString(),
    logs,
  };
  await lock.writeFile(JSON.stringify(runtime));
  await lock.close();
  const workers = [];
  let server;
  let finish;
  const stopped = new Promise((resolve) => {
    finish = resolve;
  });
  let stopping = false;
  let escalation;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const { child } of workers) {
      signalPilotChild(child, "SIGTERM");
    }
    // Migration is an owned child too; escalation cannot wait for it to finish.
    escalation = setTimeout(() => {
      for (const { child } of workers) {
        signalPilotChild(child, "SIGKILL");
      }
    }, 5_000);
    finish();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await privateDirectory(paths.logs);
    await privateDirectory(logs);
    await privateDirectory(paths.data);
    await migrate(paths, logs, workers);
    if (stopping) throw new Error("Pilot startup was stopped.");
    const wrangler = await assertPinnedWrangler();
    for (const worker of ["control", "artifact"]) {
      const process = loggedProcess(wrangler, workerArguments(worker, paths), logs, worker);
      workers.push(process);
      process.completion.then(stop, stop);
    }
    server = net.createServer((connection) => {
      connection.setTimeout(2_000, () => connection.destroy());
      let input = "";
      connection.on("data", (chunk) => {
        input += chunk.toString("utf8");
        if (input.length > 1_024) {
          connection.destroy();
          return;
        }
        if (!input.includes("\n")) return;
        try {
          const request = JSON.parse(input);
          if (
            Object.keys(request).sort().join(",") !== "action,instance" ||
            request.instance !== instance ||
            request.action !== "stop"
          )
            throw new Error("Invalid control request.");
          connection.end('{"stopping":true}\n');
          stop();
        } catch {
          connection.destroy();
        }
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.socket, resolve);
    });
    await chmod(paths.socket, 0o600);
    let ready = false;
    for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
      try {
        ready = (await health(origins.app, paths)) && (await health(origins.artifact, paths));
      } catch {
        ready = false;
      }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error("Pilot readiness failed; inspect the private Worker logs.");
    console.log(
      JSON.stringify({
        ok: true,
        origins,
        logs,
        oauth_callback: origins.app + "/auth/callback/github",
        persistent: true,
      }),
    );
    await stopped;
  } finally {
    stop();
    await Promise.allSettled(workers.map(({ completion }) => completion));
    clearTimeout(escalation);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    try {
      const current = JSON.parse(await privateFile(paths.runtime));
      if (current.instance === instance) await unlink(paths.runtime);
    } catch {
      /* Never replace another owner's metadata. */
    }
  }
}

export function bootstrapSQL(hash, createdAt, expiresAt) {
  if (
    !/^[a-f0-9]{64}$/u.test(hash) ||
    [createdAt, expiresAt].some((value) => new Date(value).toISOString() !== value) ||
    Date.parse(expiresAt) <= Date.parse(createdAt)
  )
    throw new Error("Invalid bootstrap initializer input.");
  return `INSERT INTO bootstrap_state (id, secret_hash, created_at, expires_at, consumed_at, consumption_stamp, consumed_by_human_id, workspace_id)
SELECT 'first_owner', '${hash}', '${createdAt}', '${expiresAt}', NULL, NULL, NULL, NULL
WHERE NOT EXISTS (SELECT 1 FROM workspaces) AND NOT EXISTS (SELECT 1 FROM bootstrap_state);
SELECT expires_at FROM bootstrap_state WHERE id='first_owner' AND secret_hash='${hash}'
AND consumed_at IS NULL AND expires_at > '${createdAt}' AND NOT EXISTS (SELECT 1 FROM workspaces);`;
}

export async function bootstrapCode(paths) {
  try {
    const current = (await privateFile(paths.bootstrapCode)).trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(current))
      throw new Error("Existing bootstrap code is invalid; nothing overwritten.");
    return current;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const code = randomBytes(32).toString("base64url");
  const file = await open(paths.bootstrapCode, "wx", 0o600);
  try {
    await file.writeFile(code + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  return code;
}

export async function initializeBootstrap(paths = pilotPaths()) {
  await privateDirectory(paths.root);
  const values = await readSecrets(paths.controlEnv, controlSecrets);
  if (!values.AUTH_ABUSE_SECRET || values.AUTH_ABUSE_SECRET.length < 32)
    throw new Error("AUTH_ABUSE_SECRET is required.");
  const code = await bootstrapCode(paths);
  const hash = createHmac("sha256", values.AUTH_ABUSE_SECRET)
    .update(`bfb-workspace-capability:${code}`)
    .digest("hex");
  const sqlPath = join(paths.root, `bootstrap-${randomBytes(8).toString("hex")}.sql`);
  const logs = join(
    paths.logs,
    `bootstrap-${new Date().toISOString().replaceAll(":", "-")}-${randomBytes(4).toString("hex")}`,
  );
  await privateDirectory(paths.logs);
  await privateDirectory(logs);
  const redact = (value) =>
    [hash, code, ...Object.values(values)].reduce(
      (text, secret) => (secret ? text.replaceAll(secret, "[redacted]") : text),
      value,
    );
  try {
    const now = new Date();
    const sql = await open(sqlPath, "wx", 0o600);
    await sql.writeFile(
      bootstrapSQL(hash, now.toISOString(), new Date(now.getTime() + 30 * 60_000).toISOString()),
    );
    await sql.close();
    const wrangler = await assertPinnedWrangler();
    const internalLog = join(logs, "wrangler.log");
    const child = spawn(
      wrangler,
      [
        "d1",
        "execute",
        "DB",
        "--local",
        "--config",
        join(repoRoot, "apps/control-worker/wrangler.pilot.toml"),
        "--persist-to",
        paths.data,
        "--file",
        sqlPath,
        "--json",
      ],
      {
        cwd: repoRoot,
        detached: true,
        env: wranglerEnvironment(internalLog),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let result = "";
    let stderr = "",
      exceeded = false;
    const terminate = () => {
      signalPilotChild(child, "SIGKILL");
    };
    child.stdout.on("data", (chunk) => {
      result += chunk.toString("utf8");
      if (Buffer.byteLength(result) > 65_536) {
        exceeded = true;
        terminate();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stderr) > 65_536) {
        exceeded = true;
        terminate();
      }
    });
    const timeout = setTimeout(terminate, 30_000);
    process.once("SIGTERM", terminate);
    process.once("SIGINT", terminate);
    let exit,
      logFailed = false;
    try {
      exit = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timeout);
      process.removeListener("SIGTERM", terminate);
      process.removeListener("SIGINT", terminate);
      await writeFile(join(logs, "stdout.log"), redact(result), { mode: 0o600, flag: "wx" });
      await writeFile(join(logs, "stderr.log"), redact(stderr), { mode: 0o600, flag: "wx" });
      try {
        await writeFile(internalLog, redact(await readFile(internalLog, "utf8")), { mode: 0o600 });
      } catch (error) {
        logFailed = error.code !== "ENOENT";
      }
    }
    if (exit !== 0 || exceeded || logFailed)
      throw new Error(
        `Bootstrap outcome unknown; private code retained for exact retry. Logs: ${logs}`,
      );
    const response = JSON.parse(result);
    const row = Array.isArray(response)
      ? response
          .flatMap((item) => item.results ?? [])
          .find((row) => typeof row.expires_at === "string")
      : undefined;
    if (!row)
      throw new Error(
        "Existing bootstrap differs, expired, or was consumed; private code retained and nothing overwritten.",
      );
    console.log(
      JSON.stringify({
        initialized: true,
        code_file: paths.bootstrapCode,
        expires_at: row.expires_at,
        onboarding: origins.app + "/onboarding",
        logs,
      }),
    );
  } finally {
    await unlink(sqlPath).catch(() => {});
    // An absent/invalid response cannot prove the INSERT did not commit.
    // Retain the only operator capability so the same code can reconcile.
  }
}

async function stopPilot(paths) {
  const runtime = JSON.parse(await privateFile(paths.runtime));
  await new Promise((resolve, reject) => {
    const connection = net.createConnection(paths.socket);
    connection.setTimeout(5_000, () => connection.destroy(new Error("Pilot stop timed out.")));
    connection.once("connect", () =>
      connection.write(JSON.stringify({ action: "stop", instance: runtime.instance }) + "\n"),
    );
    connection.once("error", reject);
    let response = "";
    connection.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (response.length > 1_024) connection.destroy(new Error("Invalid control response."));
    });
    connection.once("end", () => {
      if (response === '{"stopping":true}\n') resolve();
      else reject(new Error("Pilot stop was not acknowledged."));
    });
  });
  console.log(JSON.stringify({ stopping: true, persistent_data_preserved: true }));
}

export async function main(action, paths = pilotPaths()) {
  if (action === "preflight") {
    const result = await preflight(paths);
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  if (action === "start") {
    await startPilot(paths);
    return 0;
  }
  if (action === "bootstrap") {
    await initializeBootstrap(paths);
    return 0;
  }
  if (action === "stop") {
    await stopPilot(paths);
    return 0;
  }
  if (action === "status") {
    const checks = await Promise.all(
      Object.entries(origins)
        .filter(([name]) => name !== "launch")
        .map(async ([name, origin]) => ({
          name,
          healthy: await health(origin, paths).catch(() => false),
        })),
    );
    console.log(JSON.stringify({ ok: checks.every((check) => check.healthy), checks, origins }));
    return checks.every((check) => check.healthy) ? 0 : 1;
  }
  throw new Error("Use preflight, start, status, stop or bootstrap.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.length === 3 ? process.argv[2] : "").then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : "Pilot command failed.");
      process.exitCode = 1;
    },
  );
}

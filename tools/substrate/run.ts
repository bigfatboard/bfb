// ABOUTME: Exercises BFB's disposable Cloudflare substrate through real local Wrangler processes.
// ABOUTME: Verifies routing, storage, bindings, origins, cookies, Cron, and the Better Auth spike.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser } from "@playwright/test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const wranglerPath = resolve(repoRoot, "apps/control-worker/node_modules/.bin/wrangler");
const controlConfig = "apps/control-worker/wrangler.toml";
const artifactConfig = "apps/artifact-worker/wrangler.toml";
const spikeConfig = "apps/control-worker/wrangler.spike.toml";
const appOrigin = "http://bfb.localhost:8787";
const artifactOrigin = "http://artifacts.bfb.localhost:8788";
const host = "127.0.0.1";
const expectedWranglerVersion = "4.120.1";
const expectedPlaywrightVersion = "1.55.1";
const expectedBetterAuthVersion = "1.6.26";
const sessionCookieName = "bfb_session";
const sessionCookieValue = "synthetic-substrate-session";

const ports = [8787, 8788, 8790, 9229, 9230, 9232] as const;
const workerFirstPaths = [
  "/api",
  "/api/_substrate-smoke",
  "/auth",
  "/auth/_substrate-smoke",
  "/mcp",
  "/mcp/_substrate-smoke",
  "/oauth",
  "/oauth/_substrate-smoke",
  "/realtime",
  "/realtime/_substrate-smoke",
  "/runner",
  "/runner/_substrate-smoke",
  "/webhooks",
  "/webhooks/_substrate-smoke",
  "/.well-known",
  "/.well-known/_substrate-smoke",
] as const;

const dryRunConfigs = [
  ["control-local", "apps/control-worker/wrangler.toml"],
  ["control-staging", "apps/control-worker/wrangler.staging.toml"],
  ["control-production", "apps/control-worker/wrangler.production.toml"],
  ["control-spike", spikeConfig],
  ["artifact-local", "apps/artifact-worker/wrangler.toml"],
  ["artifact-staging", "apps/artifact-worker/wrangler.staging.toml"],
  ["artifact-production", "apps/artifact-worker/wrangler.production.toml"],
] as const;

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface LoggedProcess {
  label: string;
  child: ChildProcess;
  output: { stdout: string; stderr: string };
  outputDone: Promise<void>;
  exit: Promise<ProcessExit>;
  spawnError?: Error;
}

interface SmokeSummary {
  scratch: string;
  dryRuns: string[];
  spaPaths: string[];
  workerFirstPaths: string[];
  workspaceHub: {
    className: string;
    useSqlite: boolean;
    jurisdiction: string;
    instanceName: string;
    queryReady: number;
    hasStoredData: boolean;
  };
  cron: string;
  artifact: {
    setCookie: null;
    credentialedCors: null;
    appOriginAllowOrigin: null;
  };
  browserCookieIsolation: boolean;
  betterAuthSpike: { version: string; d1: boolean };
  portsClosed: boolean;
}

function childEnvironment(internalLogPath: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.FORCE_COLOR;
  return {
    ...environment,
    CI: "1",
    NO_COLOR: "1",
    WRANGLER_LOG_PATH: internalLogPath,
  };
}

function streamOutput(
  source: NodeJS.ReadableStream,
  destination: NodeJS.WritableStream,
  logPath: string,
  append: (text: string) => void,
): Promise<void> {
  const log = createWriteStream(logPath, { flags: "a" });
  return new Promise((resolvePromise, rejectPromise) => {
    source.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      append(buffer.toString("utf8"));
      destination.write(buffer);
      log.write(buffer);
    });
    source.once("error", rejectPromise);
    log.once("error", rejectPromise);
    source.once("end", () => log.end());
    log.once("finish", resolvePromise);
  });
}

function startLoggedProcess(
  label: string,
  command: string,
  args: string[],
  scratch: string,
  detached: boolean,
): LoggedProcess {
  const stdoutPath = join(scratch, `${label}.stdout.log`);
  const stderrPath = join(scratch, `${label}.stderr.log`);
  const internalLogPath = join(scratch, `${label}.wrangler.log`);
  console.log(`[substrate] ${label} stdout: ${stdoutPath}`);
  console.log(`[substrate] ${label} stderr: ${stderrPath}`);

  const child = spawn(command, args, {
    cwd: repoRoot,
    detached,
    env: childEnvironment(internalLogPath),
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert(child.stdout, `${label} stdout pipe was not created`);
  assert(child.stderr, `${label} stderr pipe was not created`);

  const processState: LoggedProcess = {
    label,
    child,
    output: { stdout: "", stderr: "" },
    outputDone: Promise.resolve(),
    exit: Promise.resolve({ code: null, signal: null }),
  };
  processState.outputDone = Promise.all([
    streamOutput(child.stdout, process.stdout, stdoutPath, (text) => {
      processState.output.stdout += text;
    }),
    streamOutput(child.stderr, process.stderr, stderrPath, (text) => {
      processState.output.stderr += text;
    }),
  ]).then(() => undefined);
  processState.exit = new Promise((resolvePromise) => {
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
  child.once("error", (error) => {
    processState.spawnError = error;
  });
  return processState;
}

async function runCommand(
  label: string,
  args: string[],
  scratch: string,
): Promise<{ stdout: string; stderr: string }> {
  console.log(`[substrate] running ${label}`);
  const running = startLoggedProcess(label, wranglerPath, args, scratch, false);
  const result = await running.exit;
  await running.outputDone;
  if (running.spawnError) {
    throw running.spawnError;
  }
  assert.equal(
    result.code,
    0,
    `${label} exited with ${String(result.code)} (${String(result.signal)})`,
  );
  return running.output;
}

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => {
      rejectPromise(new Error(`port ${port} is already in use`, { cause: error }));
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => {
        if (error) {
          rejectPromise(error);
        } else {
          resolvePromise();
        }
      });
    });
  });
}

function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(300, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitForPorts(expectedOpen: boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const states = await Promise.all(ports.map((port) => portIsOpen(port)));
    if (states.every((state) => state === expectedOpen)) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  const states = await Promise.all(ports.map((port) => portIsOpen(port)));
  const mismatches = ports.filter((_port, index) => states[index] !== expectedOpen);
  throw new Error(
    `ports did not become ${expectedOpen ? "open" : "closed"}: ${mismatches.join(", ")}`,
  );
}

async function waitForHttp(
  running: LoggedProcess,
  url: string,
  acceptedStatus = 200,
  timeoutMs = 30_000,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (running.spawnError) {
      throw running.spawnError;
    }
    if (running.child.exitCode !== null) {
      throw new Error(`${running.label} exited before readiness`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.status === acceptedStatus) {
        return response;
      }
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`${running.label} was not ready at ${url}`, { cause: lastError });
}

function signalProcessGroup(running: LoggedProcess, signal: NodeJS.Signals): void {
  const pid = running.child.pid;
  if (!pid) {
    return;
  }
  try {
    if (process.platform === "win32") {
      running.child.kill(signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

async function terminate(running: LoggedProcess): Promise<void> {
  signalProcessGroup(running, "SIGTERM");
  let timeout: NodeJS.Timeout | undefined;
  const graceful = await Promise.race([
    running.exit.then(() => true),
    new Promise<false>((resolvePromise) => {
      timeout = setTimeout(() => resolvePromise(false), 5_000);
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  if (!graceful) {
    signalProcessGroup(running, "SIGKILL");
    await running.exit;
  }
  await running.outputDone;
}

async function assertToolPins(): Promise<void> {
  const controlPackage = JSON.parse(
    await readFile(resolve(repoRoot, "apps/control-worker/package.json"), "utf8"),
  ) as { devDependencies?: Record<string, string> };
  const rootPackage = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  assert.equal(controlPackage.devDependencies?.wrangler, expectedWranglerVersion);
  assert.equal(controlPackage.devDependencies?.["better-auth"], expectedBetterAuthVersion);
  assert.equal(rootPackage.devDependencies?.["@playwright/test"], expectedPlaywrightVersion);
  await access(wranglerPath);
  await access(resolve(repoRoot, "apps/web/dist/index.html"));
}

async function runDryRuns(scratch: string): Promise<string[]> {
  const completed: string[] = [];
  for (const [name, config] of dryRunConfigs) {
    const outdir = join(scratch, "dry-run", name);
    await mkdir(outdir, { recursive: true });
    await runCommand(
      `dry-run-${name}`,
      ["deploy", "--dry-run", "--config", config, "--outdir", outdir],
      scratch,
    );
    completed.push(name);
  }
  return completed;
}

function startWorkers(scratch: string, persistPath: string): LoggedProcess[] {
  return [
    startLoggedProcess(
      "control-dev",
      wranglerPath,
      [
        "dev",
        "--config",
        controlConfig,
        "--persist-to",
        persistPath,
        "--test-scheduled",
        "--show-interactive-dev-session=false",
      ],
      scratch,
      true,
    ),
    startLoggedProcess(
      "artifact-dev",
      wranglerPath,
      [
        "dev",
        "--config",
        artifactConfig,
        "--persist-to",
        persistPath,
        "--show-interactive-dev-session=false",
      ],
      scratch,
      true,
    ),
    startLoggedProcess(
      "auth-spike-dev",
      wranglerPath,
      [
        "dev",
        "--config",
        spikeConfig,
        "--persist-to",
        persistPath,
        "--show-interactive-dev-session=false",
      ],
      scratch,
      true,
    ),
  ];
}

async function verifyControlRoutes(): Promise<{ spaPaths: string[]; workerPaths: string[] }> {
  const spaPaths = ["/", "/w/substrate-smoke", "/settings"];
  for (const path of spaPaths) {
    const response = await fetch(`http://${host}:8787${path}`, {
      headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
      redirect: "manual",
    });
    const body = await response.text();
    assert.equal(response.status, 200, `${path} did not serve the SPA`);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/i);
    assert.match(body, /<div id="root"><\/div>/);
  }

  for (const path of workerFirstPaths) {
    const response = await fetch(`http://${host}:8787${path}`, {
      headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
      redirect: "manual",
    });
    const body = await response.text();
    assert.doesNotMatch(body, /<div id="root"><\/div>/, `${path} was shadowed by SPA fallback`);
  }
  return { spaPaths, workerPaths: [...workerFirstPaths] };
}

async function verifyWorkspaceHub(): Promise<SmokeSummary["workspaceHub"]> {
  const health = await fetch(`http://${host}:8787/healthz`);
  assert.equal(health.status, 200);
  const healthPayload = (await health.json()) as {
    ok?: boolean;
    environment?: string;
    jurisdiction?: string;
    worker_first?: boolean;
  };
  assert.deepEqual(healthPayload, {
    ok: true,
    package: "F03",
    environment: "local",
    jurisdiction: "eu",
    worker_first: true,
  });

  const explorerBase = `http://${host}:8787/cdn-cgi/local/explorer/api/workers/durable_objects`;
  const response = await fetch(`${explorerBase}/namespaces`);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    success?: boolean;
    result?: Array<{ id?: string; class?: string; script?: string; use_sqlite?: boolean }>;
  };
  assert.equal(payload.success, true);
  const workspaceHub = payload.result?.find(
    (entry) => entry.class === "WorkspaceHub" && entry.script === "bfb-control-local",
  );
  assert(workspaceHub, "WorkspaceHub was absent from the local Explorer");
  assert.equal(workspaceHub.use_sqlite, true);
  assert(workspaceHub.id, "WorkspaceHub namespace id was absent from the local Explorer");

  const instanceName = "substrate-smoke-eu";
  const instanceResponse = await fetch(
    `${explorerBase}/namespaces/${encodeURIComponent(workspaceHub.id)}/query`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        durable_object_name: instanceName,
        queries: [{ sql: "SELECT 1 AS ready", params: [] }],
      }),
    },
  );
  assert.equal(instanceResponse.status, 200);
  const instancePayload = (await instanceResponse.json()) as {
    success?: boolean;
    result?: Array<{ columns?: string[]; rows?: unknown[][] }>;
  };
  assert.equal(instancePayload.success, true);
  assert.deepEqual(instancePayload.result?.[0]?.columns, ["ready"]);
  assert.deepEqual(instancePayload.result?.[0]?.rows, [[1]]);

  const objectsResponse = await fetch(
    `${explorerBase}/namespaces/${encodeURIComponent(workspaceHub.id)}/objects`,
  );
  assert.equal(objectsResponse.status, 200);
  const objectsPayload = (await objectsResponse.json()) as {
    success?: boolean;
    result?: Array<{ hasStoredData?: boolean }>;
  };
  assert.equal(objectsPayload.success, true);
  assert.equal(objectsPayload.result?.length, 1);
  assert.equal(objectsPayload.result?.[0]?.hasStoredData, true);

  return {
    className: "WorkspaceHub",
    useSqlite: true,
    jurisdiction: "eu",
    instanceName,
    queryReady: 1,
    hasStoredData: true,
  };
}

async function verifyCron(): Promise<string> {
  const cron = "*/5 * * * *";
  const query = new URLSearchParams({ cron });
  const response = await fetch(`http://${host}:8787/cdn-cgi/local/scheduled?${query}`);
  assert.equal(response.status, 200);
  return cron;
}

async function verifyArtifactBoundary(): Promise<SmokeSummary["artifact"]> {
  const healthUrl = `http://${host}:8788/healthz`;
  const health = await fetch(healthUrl);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("set-cookie"), null);
  assert.equal(health.headers.get("access-control-allow-credentials"), null);

  const artifactCors = await fetch(healthUrl, { headers: { origin: artifactOrigin } });
  assert.equal(artifactCors.headers.get("access-control-allow-origin"), artifactOrigin);
  assert.equal(artifactCors.headers.get("access-control-allow-credentials"), null);

  const appCors = await fetch(healthUrl, { headers: { origin: appOrigin } });
  assert.equal(appCors.headers.get("access-control-allow-origin"), null);
  assert.equal(appCors.headers.get("access-control-allow-credentials"), null);

  const injectedCookie = await fetch(healthUrl, {
    headers: { cookie: `${sessionCookieName}=${sessionCookieValue}` },
  });
  assert.equal(injectedCookie.status, 400);
  assert.equal(injectedCookie.headers.get("set-cookie"), null);
  const cookiePayload = (await injectedCookie.json()) as { error?: string };
  assert.equal(cookiePayload.error, "credential_confusion");

  return { setCookie: null, credentialedCors: null, appOriginAllowOrigin: null };
}

async function verifyBrowserCookieIsolation(browser: Browser): Promise<void> {
  const context = await browser.newContext();
  try {
    await context.addCookies([
      {
        name: sessionCookieName,
        value: sessionCookieValue,
        url: appOrigin,
        httpOnly: true,
        sameSite: "Lax",
        secure: false,
      },
    ]);
    const appCookies = await context.cookies(appOrigin);
    const appCookie = appCookies.find(
      (cookie) => cookie.name === sessionCookieName && cookie.value === sessionCookieValue,
    );
    assert(appCookie, "Chromium did not retain the host-only app cookie");
    assert.equal(appCookie.domain, "bfb.localhost");

    const page = await context.newPage();
    const artifactHealthUrl = `${artifactOrigin}/healthz`;
    const requestPromise = page.waitForRequest((request) => request.url() === artifactHealthUrl);
    const navigation = await page.goto(artifactHealthUrl, { waitUntil: "domcontentloaded" });
    assert(navigation, "Chromium did not receive the artifact response");
    assert.equal(navigation.status(), 200);
    const request = await requestPromise;
    const requestHeaders = await request.allHeaders();
    assert.doesNotMatch(requestHeaders.cookie ?? "", /bfb[_-]?session=/i);
  } finally {
    await context.close();
  }
}

async function verifyBetterAuthSpike(): Promise<SmokeSummary["betterAuthSpike"]> {
  const response = await fetch(`http://${host}:8790/_substrate-spike`);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { ok?: boolean; version?: string; d1?: boolean };
  assert.deepEqual(payload, { ok: true, version: expectedBetterAuthVersion, d1: true });

  const authRoute = await fetch(`http://${host}:8790/auth/sign-in`, { redirect: "manual" });
  assert.equal(authRoute.status, 404);
  return { version: expectedBetterAuthVersion, d1: true };
}

function combineFailure(current: unknown, next: unknown): unknown {
  return current === undefined ? next : new AggregateError([current, next]);
}

async function main(): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "bfb-substrate-"));
  const persistPath = join(scratch, "state");
  await mkdir(persistPath, { recursive: true });
  console.log(`[substrate] scratch and complete logs: ${scratch}`);

  const running: LoggedProcess[] = [];
  let browser: Browser | undefined;
  let summary: SmokeSummary | undefined;
  let failure: unknown;

  try {
    await assertToolPins();
    await Promise.all(ports.map((port) => assertPortAvailable(port)));
    const dryRuns = await runDryRuns(scratch);

    running.push(...startWorkers(scratch, persistPath));
    const [control, artifact, spike] = running;
    assert(control && artifact && spike);
    await Promise.all([
      waitForHttp(control, `http://${host}:8787/healthz`),
      waitForHttp(artifact, `http://${host}:8788/healthz`),
      waitForHttp(spike, `http://${host}:8790/_substrate-spike`),
    ]);
    await waitForPorts(true);

    const controlRoutes = await verifyControlRoutes();
    const workspaceHub = await verifyWorkspaceHub();
    const cron = await verifyCron();
    const artifactBoundary = await verifyArtifactBoundary();
    const betterAuthSpike = await verifyBetterAuthSpike();

    browser = await chromium.launch({
      headless: true,
      args: [
        "--host-resolver-rules=MAP bfb.localhost 127.0.0.1,MAP artifacts.bfb.localhost 127.0.0.1",
        "--no-proxy-server",
      ],
    });
    await verifyBrowserCookieIsolation(browser);

    summary = {
      scratch,
      dryRuns,
      spaPaths: controlRoutes.spaPaths,
      workerFirstPaths: controlRoutes.workerPaths,
      workspaceHub,
      cron,
      artifact: artifactBoundary,
      browserCookieIsolation: true,
      betterAuthSpike,
      portsClosed: false,
    };
  } catch (error) {
    failure = error;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        failure = combineFailure(failure, error);
      }
    }
    for (const processToStop of [...running].reverse()) {
      try {
        await terminate(processToStop);
      } catch (error) {
        failure = combineFailure(failure, error);
      }
    }
    try {
      await waitForPorts(false);
      if (summary) {
        summary.portsClosed = true;
      }
    } catch (error) {
      failure = combineFailure(failure, error);
    }
  }

  if (failure !== undefined) {
    console.error(`[substrate] failed; complete logs retained at ${scratch}`);
    throw failure;
  }
  assert(summary);
  console.log(JSON.stringify(summary, null, 2));
  console.log("F03_SUBSTRATE_OK");
}

await main();

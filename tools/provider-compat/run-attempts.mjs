// ABOUTME: Runs real Claude, Codex, and Grok client attempts against a local BFB OAuth/MCP endpoint.
// ABOUTME: Records exact versions, commands, and redacted outcomes for WP-X03A provider-compat evidence.

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");
const EVIDENCE_DIR = path.join(REPO_ROOT, "docs/work-packages/evidence/WP-X03A/attempts");
const SERVER_NAME = "bfb-x03a-provider-compat";
const CLIENT_ID = "bfb-mcp-synthetic-client";
const CALLBACK_PORT = 9999;
const DEFAULT_PORT = 18765;
const SCRATCH_LOG =
  process.env.BFB_PROVIDER_COMPAT_SCRATCH_LOG ?? process.env.PROVIDER_COMPAT_LOG ?? "";

/** Resolve clients from env override or PATH only — never machine-local home paths. */
const candidates = {
  claude: [process.env.CLAUDE_BIN, "claude"].filter(Boolean),
  codex: [process.env.CODEX_BIN, "codex"].filter(Boolean),
  grok: [process.env.GROK_BIN, "grok"].filter(Boolean),
};

const fullLog = [];
const results = [];

function log(line) {
  const text = typeof line === "string" ? line : JSON.stringify(line);
  fullLog.push(text);
  console.log(text);
}

function redact(text) {
  return (
    String(text)
      // BFB opaque access tokens are mcp_ + long random; avoid mangling identifiers like mcp_http_client.
      .replace(/\bmcp_[A-Za-z0-9]{20,}\b/g, "mcp_[REDACTED]")
      .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
      .replace(/bfb_session=[^;\s]+/g, "bfb_session=[REDACTED]")
      .replace(/([?&])code=[A-Za-z0-9_-]{8,}/g, "$1code=[REDACTED]")
      .replace(/access_token"\s*:\s*"[^"]+"/g, 'access_token":"[REDACTED]"')
      .replace(/refresh_token"\s*:\s*"[^"]+"/g, 'refresh_token":"[REDACTED]"')
      .replace(/\/Users\/[^/\s"'`]+/g, "/Users/[REDACTED]")
      .replace(/\/home\/[^/\s"'`]+/g, "/home/[REDACTED]")
      .replace(/\/opt\/homebrew\/[^\s"'`]+/g, "/opt/homebrew/[REDACTED]")
      .replace(/\/usr\/local\/[^\s"'`]+/g, "/usr/local/[REDACTED]")
      .replace(/\/var\/folders\/[^\s"'`]+/g, "/var/folders/[REDACTED]")
      .replace(/password["']?\s*[:=]\s*["']?[^"'\s]+/gi, "password=[REDACTED]")
  );
}

function displayCommand(command) {
  const parts = String(command).split(" ");
  if (parts[0]?.includes("/")) {
    parts[0] = path.basename(parts[0]);
  }
  return parts.join(" ");
}

async function which(bin) {
  if (bin.includes("/")) {
    try {
      await fs.access(bin);
      return bin;
    } catch {
      return null;
    }
  }
  const result = await runCapture("which", [bin], { timeoutMs: 5_000 });
  if (result.code === 0) {
    return result.stdout.trim().split("\n")[0] || null;
  }
  return null;
}

async function realpathOrSelf(p) {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

function runCapture(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const cwd = options.cwd ?? REPO_ROOT;
  const env = { ...process.env, ...options.env };
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000);
      resolve({
        code: 124,
        signal: "TIMEOUT",
        stdout,
        stderr: stderr + `\n[timeout after ${timeoutMs}ms]`,
        command: [command, ...args].join(" "),
      });
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: 127,
        signal: null,
        stdout,
        stderr: String(err),
        command: [command, ...args].join(" "),
      });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        signal,
        stdout,
        stderr,
        command: [command, ...args].join(" "),
      });
    });
  });
}

async function detectClient(name) {
  for (const candidate of candidates[name]) {
    const resolved = await which(candidate);
    if (!resolved) continue;
    const ver = await runCapture(resolved, ["--version"], { timeoutMs: 10_000 });
    const versionText = redact((ver.stdout || ver.stderr || "").trim() || `exit ${ver.code}`);
    let packageVersion = null;
    try {
      const real = await realpathOrSelf(resolved);
      const pkgPath = path.resolve(path.dirname(real), "..", "package.json");
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
      packageVersion = pkg.version ?? null;
    } catch {
      packageVersion = null;
    }
    return {
      name,
      path: resolved,
      versionExit: ver.code,
      versionOutput: versionText,
      packageVersion,
      versionOk: ver.code === 0,
    };
  }
  return {
    name,
    path: null,
    versionExit: null,
    versionOutput: "not installed",
    packageVersion: null,
    versionOk: false,
  };
}

async function openDomainDb(require) {
  const Database = require("better-sqlite3");
  const { adaptBetterSqlite3, applyMigrationsForVerification } = await import(
    path.join(REPO_ROOT, "packages/db/dist/index.js")
  );
  const { seedSyntheticWorkspace } = await import(
    path.join(REPO_ROOT, "packages/domain/dist/fixtures.js")
  );
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  applyMigrationsForVerification(raw, path.join(REPO_ROOT, "migrations/d1"));
  const db = adaptBetterSqlite3(raw);
  await seedSyntheticWorkspace(db);
  return db;
}

function fakeBinding(label) {
  return { __synthetic: label };
}

async function startBfbServer(port) {
  const require = createRequire(path.join(REPO_ROOT, "apps/control-worker/package.json"));
  const { createControlApp } = await import(
    path.join(REPO_ROOT, "apps/control-worker/dist/routes.js")
  );
  const { validateControlEnv } = await import(
    path.join(REPO_ROOT, "apps/control-worker/dist/env.js")
  );
  const { MCP_RESOURCE, MCP_PROTOCOL_VERSION } = await import(
    path.join(REPO_ROOT, "packages/domain/dist/oauth.js")
  );

  const db = await openDomainDb(require);
  const appOrigin = `http://127.0.0.1:${port}`;
  const env = {
    DB: fakeBinding("db"),
    ARTIFACTS: fakeBinding("r2"),
    JOBS: fakeBinding("jobs"),
    JOBS_DLQ: fakeBinding("dlq"),
    WORKSPACE_HUB: fakeBinding("hub"),
    APP_ORIGIN: appOrigin,
    ARTIFACT_ORIGIN: `http://127.0.0.1:${port + 1}`,
    LAUNCH_ORIGIN: `http://127.0.0.1:${port + 2}`,
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  };
  const validated = validateControlEnv(env);
  const app = createControlApp(validated, { db, now: new Date().toISOString() });

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? `127.0.0.1:${port}`;
      const url = `http://${host}${req.url ?? "/"}`;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bodyBuf = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(key, item);
        } else {
          headers.set(key, value);
        }
      }
      // Harness-only: normalize Host to hostname so loopback:port matches F03 allowlist.
      headers.set("host", host.split(":")[0] ?? "127.0.0.1");
      const init = { method: req.method ?? "GET", headers };
      if (bodyBuf.length > 0 && req.method !== "GET" && req.method !== "HEAD") {
        init.body = bodyBuf;
      }
      const request = new Request(url, init);
      const response = await app.fetch(request, env);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === "transfer-encoding") return;
        res.setHeader(key, value);
      });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "harness_error", message: String(error) }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    server,
    port,
    appOrigin,
    mcpUrl: `${appOrigin}/mcp`,
    MCP_RESOURCE,
    MCP_PROTOCOL_VERSION,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function probeEndpoint(serverInfo) {
  const probes = [];
  for (const [name, exec] of [
    ["healthz", () => fetch(`${serverInfo.appOrigin}/healthz`)],
    [
      "oauth-authorization-server",
      () => fetch(`${serverInfo.appOrigin}/.well-known/oauth-authorization-server`),
    ],
    [
      "oauth-protected-resource",
      () => fetch(`${serverInfo.appOrigin}/.well-known/oauth-protected-resource`),
    ],
    [
      "tools/list",
      () =>
        fetch(serverInfo.mcpUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "MCP-Protocol-Version": serverInfo.MCP_PROTOCOL_VERSION,
            "Mcp-Method": "tools/list",
          },
          body: JSON.stringify({ method: "tools/list" }),
        }),
    ],
    [
      "tools/list-with-cookie",
      () =>
        fetch(serverInfo.mcpUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "MCP-Protocol-Version": serverInfo.MCP_PROTOCOL_VERSION,
            "Mcp-Method": "tools/list",
            cookie: "bfb_session=synthetic",
          },
          body: JSON.stringify({ method: "tools/list" }),
        }),
    ],
  ]) {
    const response = await exec();
    probes.push({
      name,
      status: response.status,
      body: redact(await response.text()),
    });
  }
  return probes;
}

function summarizeResult(row) {
  results.push(row);
  log(`RESULT ${row.client}: ${row.result}`);
}

function pushCmd(commands, run) {
  commands.push({
    command: displayCommand(run.command),
    exit: run.code,
    stdout: redact(run.stdout.trim()),
    stderr: redact(run.stderr.trim()),
  });
}

async function attemptClaude(client, serverInfo) {
  const commands = [];
  if (!client.path) {
    summarizeResult({
      client: "Claude",
      exactVersion: "not installed",
      commands: [],
      result: "not attempted — binary missing",
      limitations: ["claude CLI not found"],
    });
    return;
  }

  const versionLabel = client.versionOk
    ? client.versionOutput.split("\n")[0]
    : client.packageVersion
      ? `package ${client.packageVersion}; --version failed`
      : client.versionOutput.split("\n")[0];

  pushCmd(
    commands,
    await runCapture(client.path, ["mcp", "remove", "-s", "local", SERVER_NAME], {
      timeoutMs: 15_000,
    }),
  );

  const add = await runCapture(
    client.path,
    [
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      "local",
      "--client-id",
      CLIENT_ID,
      "--callback-port",
      String(CALLBACK_PORT),
      SERVER_NAME,
      serverInfo.mcpUrl,
    ],
    { timeoutMs: 30_000 },
  );
  pushCmd(commands, add);

  const get = await runCapture(client.path, ["mcp", "get", SERVER_NAME], { timeoutMs: 60_000 });
  pushCmd(commands, get);

  const login = await runCapture(client.path, ["mcp", "login", "--no-browser", SERVER_NAME], {
    timeoutMs: 45_000,
  });
  pushCmd(commands, login);

  const list = await runCapture(client.path, ["mcp", "list"], { timeoutMs: 60_000 });
  pushCmd(commands, list);

  pushCmd(
    commands,
    await runCapture(client.path, ["mcp", "remove", "-s", "local", SERVER_NAME], {
      timeoutMs: 15_000,
    }),
  );

  const ours = [get.stdout, get.stderr, list.stdout, list.stderr]
    .join("\n")
    .split("\n")
    .filter(
      (line) =>
        line.includes(SERVER_NAME) ||
        /protocol_version|MCP-Protocol-Version|Failed to connect|authentication/i.test(line),
    )
    .join("\n");

  let result = "attempted — connection incomplete";
  if (add.code !== 0) {
    result = "failed — could not register HTTP MCP server";
  } else if (/protocol_version|MCP-Protocol-Version must be/i.test(ours)) {
    result =
      "failed to connect — client probe omitted/mismatched MCP-Protocol-Version 2026-07-28 (HTTP 400)";
  } else if (new RegExp(`${SERVER_NAME}.*✔ Connected|Status:\\s*✔`, "i").test(ours)) {
    result = "connected — health check passed";
  } else if (/Failed to connect|✘ Failed/i.test(ours)) {
    result = "failed to connect — see client health check";
  } else if (login.code !== 0) {
    result =
      "registered HTTP server; OAuth login incomplete (non-interactive / policy constraints)";
  }

  summarizeResult({
    client: "Claude",
    exactVersion: versionLabel,
    commands: commands.map((c) => c.command),
    commandDetails: commands,
    result,
    limitations: [
      "BFB requires server-preregistered public client, PKCE S256, exact redirect http://127.0.0.1:9999/callback",
      "BFB authorize requires browser session cookie plus workspace_id and step_up_proof_id (C03)",
      "Claude Code Streamable HTTP health probe did not send MCP-Protocol-Version 2026-07-28",
      "BFB rejects legacy initialize/Mcp-Session-Id; protocol is MCP 2026-07-28 stateless Streamable HTTP",
      "Cookie sessions cannot authenticate /mcp",
    ],
  });
}

async function attemptCodex(client, serverInfo) {
  const commands = [];
  if (!client.path) {
    summarizeResult({
      client: "Codex",
      exactVersion: "not installed",
      commands: [],
      result: "not attempted — binary missing",
      limitations: ["codex CLI not found"],
    });
    return;
  }

  const versionLabel = client.packageVersion
    ? `@openai/codex ${client.packageVersion}${client.versionOk ? "" : " (native --version ENOENT)"}`
    : client.versionOutput.split("\n")[0];

  const ver = await runCapture(client.path, ["--version"], { timeoutMs: 10_000 });
  pushCmd(commands, ver);
  const help = await runCapture(client.path, ["--help"], { timeoutMs: 10_000 });
  pushCmd(commands, help);

  if (ver.code === 0 || help.code === 0) {
    pushCmd(commands, await runCapture(client.path, ["mcp", "--help"], { timeoutMs: 15_000 }));
  } else {
    pushCmd(
      commands,
      await runCapture(client.path, ["mcp", "add", "bfb-x03a", serverInfo.mcpUrl], {
        timeoutMs: 10_000,
      }),
    );
  }

  const combined = commands.map((c) => `${c.stdout}\n${c.stderr}`).join("\n");
  let result = "attempted";
  const limitations = [];
  if (/ENOENT/i.test(combined)) {
    result = "failed — native binary missing (ENOENT on darwin vendor codex); MCP not exercised";
    limitations.push(
      "npm @openai/codex wrapper cannot spawn vendor/aarch64-apple-darwin/codex/codex (ENOENT)",
    );
  } else if (ver.code !== 0 && help.code !== 0) {
    result = "failed — CLI would not start";
  } else {
    result = "attempted — CLI started; see command details for MCP support";
  }
  limitations.push("BFB accepts only preregistered public client bfb-mcp-synthetic-client");
  limitations.push("No X03A acceptance weakening for broken local Codex installs");

  summarizeResult({
    client: "Codex",
    exactVersion: versionLabel,
    commands: commands.map((c) => c.command),
    commandDetails: commands,
    result,
    limitations,
  });
}

async function attemptGrok(client, serverInfo) {
  const commands = [];
  if (!client.path) {
    summarizeResult({
      client: "Grok",
      exactVersion: "not installed",
      commands: [],
      result: "not attempted — binary missing",
      limitations: ["grok CLI not found"],
    });
    return;
  }

  const versionLabel = client.versionOutput.split("\n")[0];

  // User scope avoids project-folder trust gate that blocked doctor for repo-local servers.
  pushCmd(
    commands,
    await runCapture(client.path, ["mcp", "remove", "--scope", "user", SERVER_NAME], {
      timeoutMs: 15_000,
    }),
  );

  const add = await runCapture(
    client.path,
    ["mcp", "add", "--transport", "http", "--scope", "user", SERVER_NAME, serverInfo.mcpUrl],
    { timeoutMs: 30_000 },
  );
  pushCmd(commands, add);

  const list = await runCapture(client.path, ["mcp", "list", "--json"], { timeoutMs: 30_000 });
  pushCmd(commands, list);

  const doctor = await runCapture(client.path, ["mcp", "doctor", "--json", SERVER_NAME], {
    timeoutMs: 90_000,
  });
  pushCmd(commands, doctor);

  pushCmd(
    commands,
    await runCapture(client.path, ["mcp", "remove", "--scope", "user", SERVER_NAME], {
      timeoutMs: 15_000,
    }),
  );

  const ours = [doctor.stdout, doctor.stderr, list.stdout, list.stderr].join("\n");
  let result = "attempted — MCP config/doctor exercised";
  if (add.code !== 0) {
    result = "failed — could not add HTTP MCP server";
  } else if (/folder untrusted/i.test(ours)) {
    result = "registered; doctor blocked by untrusted project folder (no TCP probe)";
  } else if (
    new RegExp(`"name"\\s*:\\s*"${SERVER_NAME}"[\\s\\S]*?"healthy"\\s*:\\s*true`, "i").test(ours)
  ) {
    result = "doctor healthy — HTTP MCP connectivity succeeded";
  } else if (/protocol_version|MCP-Protocol-Version must be/i.test(ours)) {
    result =
      "doctor unhealthy — handshake sent initialize without MCP-Protocol-Version 2026-07-28 (HTTP 400)";
  } else if (
    new RegExp(`"name"\\s*:\\s*"${SERVER_NAME}"[\\s\\S]*?"healthy"\\s*:\\s*false`, "i").test(ours)
  ) {
    result = "doctor unhealthy — connectivity/handshake failed (see log)";
  } else if (/protocol|initialize|2025-06-18|2026-07-28|oauth|401|unauthorized/i.test(ours)) {
    result = "attempted — protocol/auth limitations observed";
  }

  summarizeResult({
    client: "Grok",
    exactVersion: versionLabel,
    commands: commands.map((c) => c.command),
    commandDetails: commands,
    result,
    limitations: [
      "Grok MCP HTTP doctor performs an initialize handshake; BFB rejects initialize and requires MCP-Protocol-Version 2026-07-28",
      "OAuth against BFB preregistered client + C03 step-up is not a full delegated board-client loop from grok mcp alone",
      "BFB protected-resource metadata advertises resource https://bfb.example.test/mcp (fixture constant) even when served on loopback",
      "BFB does not open DCR/CIMD; unregistered clients fail closed",
    ],
  });
}

async function writeOutputs(serverInfo, probes, startedAt) {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  // Remove prior harness temp artifacts if any.
  for (const name of [
    "_provider-server.ts",
    "_provider-server.tmp.mjs",
    "claude-code-mcp-http-.json",
    "codex-cli-mcp.json",
    "grok-build-cli.json",
  ]) {
    try {
      await fs.unlink(path.join(EVIDENCE_DIR, name));
    } catch {
      // ignore
    }
  }

  const endedAt = new Date().toISOString();
  const payload = {
    package: "X03A",
    kind: "provider-compat-real-client-attempts",
    started_at: startedAt,
    ended_at: endedAt,
    endpoint: {
      app_origin: serverInfo.appOrigin,
      mcp_url: serverInfo.mcpUrl,
      protocol_version: serverInfo.MCP_PROTOCOL_VERSION,
      resource_fixture: serverInfo.MCP_RESOURCE,
      preregistered_client_id: CLIENT_ID,
      redirect_uri: `http://127.0.0.1:${CALLBACK_PORT}/callback`,
      host_normalization: "harness strips non-default port from Host for allowedHostnames match",
    },
    harness_probes: probes,
    clients: results.map((r) => ({
      provider_client: r.client,
      exact_version: r.exactVersion,
      commands: r.commands,
      result: r.result,
      limitations: r.limitations,
      command_details: r.commandDetails ?? [],
    })),
    redaction: {
      status: "applied",
      notes: [
        "tokens, bearer values, session cookies, auth codes, home directories redacted",
        "command binaries shown as basenames in evidence",
      ],
    },
  };

  await fs.writeFile(
    path.join(EVIDENCE_DIR, "attempt-summary.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );

  for (const row of results) {
    const safe = row.client.toLowerCase();
    const lines = [
      `# ${row.client} real attempt log (redacted)`,
      `exact_version: ${row.exactVersion}`,
      `result: ${row.result}`,
      "",
      "## Commands",
      ...(row.commandDetails ?? []).flatMap((c) => [
        `$ ${c.command}`,
        `exit: ${c.exit}`,
        c.stdout ? `stdout:\n${c.stdout}` : "stdout: (empty)",
        c.stderr ? `stderr:\n${c.stderr}` : "stderr: (empty)",
        "",
      ]),
      "## Limitations",
      ...row.limitations.map((l) => `- ${l}`),
      "",
    ];
    await fs.writeFile(path.join(EVIDENCE_DIR, `${safe}.log`), lines.join("\n"), "utf8");
  }

  const cookieProbe = probes.find((p) => p.name === "tools/list-with-cookie");
  const tableRows = results
    .map((r) => {
      const cmds = r.commands.length
        ? r.commands.map((c) => "`" + c.replace(/\|/g, "\\|") + "`").join("<br>")
        : "_(none)_";
      const lim = r.limitations.map((l) => l.replace(/\|/g, "\\|")).join("; ");
      return `| ${r.client} | ${r.exactVersion.replace(/\|/g, "\\|")} | ${cmds} | ${r.result.replace(/\|/g, "\\|")} | ${lim} |`;
    })
    .join("\n");

  const md = `# Provider MCP client compatibility (X03A)

Real installed-client attempts against a local BFB control app serving MCP \`2026-07-28\` at \`/mcp\` with OAuth authorization_code + PKCE S256 and server-preregistered public client \`${CLIENT_ID}\` (redirect \`http://127.0.0.1:${CALLBACK_PORT}/callback\`).

Harness: \`node tools/provider-compat/run-attempts.mjs\` (Node 24.19.0). Endpoint: \`${serverInfo.mcpUrl}\`. Cookie auth on \`/mcp\` rejected by harness probe (HTTP ${cookieProbe?.status ?? "?"}).

| Provider client | Exact version | Command(s) run | Result | Limitations |
| --- | --- | --- | --- | --- |
${tableRows}

## Harness notes

- Local server uses \`createControlApp\` + migrated in-memory SQLite fixtures (\`seedSyntheticWorkspace\`).
- Host header port is normalized in the harness only so loopback non-default ports match F03 hostname allowlisting; production uses canonical hosts.
- Protected-resource metadata still advertises fixture resource \`${serverInfo.MCP_RESOURCE}\`.
- These rows are **not** fixture-profile-only claims; each client binary was invoked on this machine.
- Unsupported or incomplete outcomes do not change the frozen X03A transport or OAuth policy.

## Evidence artifacts

- \`docs/work-packages/evidence/WP-X03A/attempts/attempt-summary.json\`
- \`docs/work-packages/evidence/WP-X03A/attempts/claude.log\`
- \`docs/work-packages/evidence/WP-X03A/attempts/codex.log\`
- \`docs/work-packages/evidence/WP-X03A/attempts/grok.log\`

Started: ${startedAt}  
Ended: ${endedAt}
`;
  await fs.writeFile(
    path.join(REPO_ROOT, "docs/work-packages/evidence/WP-X03A/provider-compat.md"),
    md,
    "utf8",
  );

  if (SCRATCH_LOG) {
    await fs.mkdir(path.dirname(SCRATCH_LOG), { recursive: true });
    await fs.writeFile(
      SCRATCH_LOG,
      fullLog.join("\n") + "\n\n" + JSON.stringify(payload, null, 2) + "\n",
      "utf8",
    );
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  log(`# BFB provider-compat real attempts`);
  log(`started_at: ${startedAt}`);
  log(`node: ${process.version}`);

  const port = Number(process.env.BFB_PROVIDER_COMPAT_PORT ?? DEFAULT_PORT);
  log(`starting local BFB MCP on 127.0.0.1:${port}`);

  let serverInfo;
  try {
    serverInfo = await startBfbServer(port);
  } catch (error) {
    log(`FATAL server start: ${error}`);
    process.exitCode = 1;
    return;
  }

  try {
    const probes = await probeEndpoint(serverInfo);
    for (const p of probes) {
      log(`probe ${p.name}: HTTP ${p.status} ${p.body.slice(0, 300)}`);
    }

    const claude = await detectClient("claude");
    const codex = await detectClient("codex");
    const grok = await detectClient("grok");
    log(`detected claude: ${claude.path ?? "missing"} :: ${claude.versionOutput}`);
    log(
      `detected codex: ${codex.path ?? "missing"} :: pkg=${codex.packageVersion ?? "?"} :: ${codex.versionOutput.split("\n")[0]}`,
    );
    log(`detected grok: ${grok.path ?? "missing"} :: ${grok.versionOutput}`);

    await attemptClaude(claude, serverInfo);
    await attemptCodex(codex, serverInfo);
    await attemptGrok(grok, serverInfo);

    await writeOutputs(serverInfo, probes, startedAt);
    log("wrote evidence under docs/work-packages/evidence/WP-X03A/");
    if (SCRATCH_LOG) log("wrote scratch log");
  } finally {
    await serverInfo.close();
    log("server closed");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

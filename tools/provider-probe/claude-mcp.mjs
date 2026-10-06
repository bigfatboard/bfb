// ABOUTME: Observes one isolated Claude MCP handshake and hook shape without filesystem tools.
// ABOUTME: Retains only bounded synthetic protocol metadata and never grants adapter capabilities.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

process.umask(0o077);
const mode = process.argv[2];
const reportPath = process.argv[3];
const textValue = (value, maximum = 128) =>
  typeof value === "string" && value.length <= maximum && /^[A-Za-z0-9._:/-]+$/.test(value)
    ? value
    : null;
const record = (value) => appendFileSync(reportPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });

if (mode === "--server") {
  let count = 0;
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (++count > 32 || Buffer.byteLength(line) > 65536) process.exit(2);
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      process.exit(2);
    }
    const method = textValue(request.method);
    record({
      surface: "mcp",
      method,
      protocol_version: textValue(request.params?.protocolVersion),
      metadata_protocol_version: textValue(
        request.params?._meta?.["io.modelcontextprotocol/protocolVersion"],
      ),
      capability_names: Object.keys(request.params?.capabilities ?? {})
        .slice(0, 16)
        .map((key) => textValue(key)),
      client_name: textValue(request.params?.clientInfo?.name),
      client_version: textValue(request.params?.clientInfo?.version),
    });
    if (request.id === undefined) continue;
    let result;
    if (method === "initialize") {
      const requested = request.params?.protocolVersion;
      const supported = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
      result = {
        protocolVersion: supported.includes(requested) ? requested : "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "bfb-synthetic-handshake-probe", version: "1.0.0" },
      };
    } else if (method === "tools/list") {
      result = {
        tools: [
          {
            name: "bfb_probe_metadata",
            description: "Return a fixed synthetic handshake marker. No data or filesystem access.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      };
    } else if (
      method === "tools/call" &&
      request.params?.name === "bfb_probe_metadata" &&
      Object.keys(request.params?.arguments ?? {}).length === 0
    ) {
      result = { content: [{ type: "text", text: "BFB_SYNTHETIC_HANDSHAKE_OK" }] };
    } else if (method === "ping") {
      result = {};
    }
    const response =
      result === undefined
        ? { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }
        : { jsonrpc: "2.0", id: request.id, result };
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
  process.exit(0);
}

if (mode === "--hook") {
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 65536) process.exit(2);
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const events = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "SessionEnd",
  ];
  record({
    surface: "hook",
    event: events.includes(input.hook_event_name) ? input.hook_event_name : null,
    source: ["startup", "resume", "clear", "compact", "fork"].includes(input.source)
      ? input.source
      : null,
    keys: Object.keys(input)
      .slice(0, 32)
      .map((key) => textValue(key)),
    session_matches: input.session_id === process.argv[4],
  });
  if (input.hook_event_name === "SessionStart") {
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext:
            "This is an isolated BFB protocol probe. Only call bfb_probe_metadata; no files or business state are accessible.",
        },
      })}\n`,
    );
  }
  process.exit(0);
}

if (mode !== undefined) throw new Error("Usage: node tools/provider-probe/claude-mcp.mjs");
const root = mkdtempSync(path.join(tmpdir(), "bfb-claude-mcp-probe-"));
const report = path.join(root, "metadata.jsonl");
writeFileSync(report, "", { mode: 0o600 });
const script = fileURLToPath(import.meta.url);
const environment = Object.fromEntries(
  ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "SHELL", "LANG"].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
);
environment.DISABLE_AUTOUPDATER = "1";
environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
const located = spawnSync("/usr/bin/which", ["claude"], {
  env: environment,
  encoding: "utf8",
  timeout: 10000,
});
if (located.status !== 0) throw new Error("Claude executable unavailable");
const binary = realpathSync(located.stdout.trim());
const version = spawnSync(binary, ["--version"], {
  env: environment,
  encoding: "utf8",
  timeout: 10000,
  maxBuffer: 8192,
});
if (version.status !== 0 || version.stdout.trim() !== "2.1.291 (Claude Code)") {
  throw new Error("Installed Claude version changed; review this exact probe before running");
}
const digest = () => createHash("sha256").update(readFileSync(binary)).digest("hex");
const before = digest();
const session = randomUUID();
const settings = path.join(root, "settings.json");
const mcp = path.join(root, "mcp.json");
const events = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SessionEnd",
];
writeFileSync(
  settings,
  JSON.stringify({
    crossSessionInbound: "refuse",
    disableAllHooks: false,
    hooks: Object.fromEntries(
      events.map((event) => [
        event,
        [
          {
            hooks: [
              {
                type: "command",
                command: process.execPath,
                args: [script, "--hook", report, session],
              },
            ],
          },
        ],
      ]),
    ),
  }),
  { mode: 0o600 },
);
writeFileSync(
  mcp,
  JSON.stringify({
    mcpServers: {
      bfb_probe: {
        type: "stdio",
        command: process.execPath,
        args: [script, "--server", report],
        env: {},
      },
    },
  }),
  { mode: 0o600 },
);
const args = [
  "-p",
  "--restricted",
  "--strict-mcp-config",
  "--mcp-config",
  mcp,
  "--setting-sources",
  "",
  "--settings",
  settings,
  "--tools",
  "",
  "--allowedTools",
  "mcp__bfb_probe__bfb_probe_metadata",
  "--permission-mode",
  "dontAsk",
  "--permission-prompts",
  "none",
  "--disable-slash-commands",
  "--no-chrome",
  "--no-session-persistence",
  "--session-id",
  session,
  "--model",
  "haiku",
  "--effort",
  "low",
  "--max-turns",
  "2",
  "--max-budget-usd",
  "0.25",
  "--output-format",
  "json",
  "Call bfb_probe_metadata exactly once, then finish. Do not use any other tool or access files.",
];
console.log(
  JSON.stringify({ phase: "start", version: version.stdout.trim(), report_directory: root }),
);
const child = spawn(binary, args, {
  cwd: root,
  env: environment,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let bytes = 0;
let timedOut = false;
let outputLimit = false;
let killTimer;
const stop = () => {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  killTimer ??= setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }, 5000);
};
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (data) => {
    bytes += data.length;
    if (bytes > 262144) {
      outputLimit = true;
      stop();
    }
  });
const timer = setTimeout(() => {
  timedOut = true;
  stop();
}, 90000);
const outcome = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => resolve({ code, signal }));
});
clearTimeout(timer);
clearTimeout(killTimer);
const records = readFileSync(report, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
console.log(
  JSON.stringify({
    phase: "complete",
    ...outcome,
    timed_out: timedOut,
    output_limit: outputLimit,
    output_bytes: bytes,
    binary_unchanged: digest() === before,
    records,
  }),
);
if (outcome.code !== 0 || timedOut || outputLimit || digest() !== before) process.exitCode = 1;

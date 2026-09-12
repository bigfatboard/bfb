// ABOUTME: Exercises the signed native app against a private synthetic daemon and real Unix sockets.
// ABOUTME: Verifies app-only lifetime, wake identity, signing boundaries and noninteractive native failures.

import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import {
  appendFile,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildSignedApp, run } from "./build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const capture = promisify(execFile);
const workspace = await mkdtemp("/tmp/bfb-l04-");
const state = join(workspace, "state");
await mkdir(state, { mode: 0o700 });
const wake = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const local = "e0da52a9-d0cb-47d8-867b-e08f684b9001";
const selfHostedOnly = process.env.BFB_MACOS_TEST_SELF_HOSTED === "1";
assert.ok(
  !selfHostedOnly || !process.argv.includes("--require-managed"),
  "Self-hosted diagnostics cannot satisfy the complete L04 managed-link gate",
);
const associatedHosts = selfHostedOnly ? [] : ["launch.bfb.example"];
let build;
let daemon;
let daemonClosed;
let appPID;
let probe;

async function probeJSON(...args) {
  const { stdout } = await capture(probe, args, { env: build.env, timeout: 15000 });
  return JSON.parse(stdout);
}

async function rpc(method, payload = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(join(state, "daemon.sock"));
    socket.setTimeout(12000, () => socket.destroy(new Error("native RPC timed out")));
    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
    socket.once("connect", () =>
      socket.write(
        JSON.stringify({
          schema_version: 1,
          request_id: id,
          method,
          direction: "request",
          payload,
        }) + "\n",
      ),
    );
    let data = "";
    socket.on("data", (bytes) => {
      data += bytes.toString("utf8");
      if (data.length > 65536) socket.destroy(new Error("native RPC exceeded its bound"));
      if (data.includes("\n")) {
        try {
          const response = JSON.parse(data);
          assert.equal(response.request_id, id);
          assert.equal(response.method, method);
          socket.end();
          resolve(response);
        } catch (error) {
          socket.destroy(error);
        }
      }
    });
    socket.once("error", reject);
  });
}

async function until(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error("Timed out: " + label);
}

const running = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const readPID = (response) =>
  Number(response.payload.log_entries.find((line) => line.startsWith("app_pid:")).slice(8));

async function socketCase(name, answer, expected, options = {}) {
  const directory = join(workspace, name);
  await mkdir(directory, { mode: 0o700 });
  const path = join(directory, "daemon.sock");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", async (data) => {
      const request = JSON.parse(data.toString("utf8"));
      const response = {
        schema_version: 1,
        request_id: request.request_id,
        method: request.method,
        direction: "response",
        payload: { status: "running", daemon_pid: 42 },
      };
      await answer(socket, response);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  await chmod(path, options.socketMode ?? 0o600);
  if (options.rootMode) await chmod(directory, options.rootMode);
  try {
    const result = await probeJSON(
      ...(options.cancel ? ["cancel", directory] : ["call", directory, "daemon.status"]),
    );
    if (expected === "accept") assert.equal(result.payload?.status, "running", name);
    else assert.equal(result.code, expected, name);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

try {
  build = await buildSignedApp({
    configuration: "Debug",
    testStateDirectory: state,
    associatedHosts,
    provisioningProfile: process.env.BFB_MACOS_PROFILE,
    helperPackage: "./internal/appbridge/testdata/acceptance",
  });
  console.log("Native acceptance build: " + build.app);
  probe = join(workspace, "native-probe");
  const sources = [
    "WireGenerated.swift",
    "WireCodec.swift",
    "LocalRPC.swift",
    "NativeActions.swift",
  ].map((file) => join(root, "apps/macos/Sources/BFB", file));
  await run(
    "xcrun",
    [
      "swiftc",
      "-swift-version",
      "6",
      "-parse-as-library",
      ...sources,
      "tools/macos/probe.swift",
      "-o",
      probe,
    ],
    { env: build.env },
  );
  const signature = await probeJSON("installation", build.app);
  assert.equal(signature.ok, true);
  assert.equal(signature.helper_name, "bfb");
  assert.deepEqual(signature.hosts, associatedHosts);
  assert.equal(
    (await probeJSON("installation", await realpath(build.app))).ok,
    true,
    "The verified helper must remain usable through macOS's private filesystem alias",
  );
  const info = join(build.app, "Contents/Info.plist");
  const scheme = await capture("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleURLTypes:0:CFBundleURLSchemes:0",
    info,
  ]);
  assert.equal(scheme.stdout.trim(), "bfb");
  const menuBar = await capture("/usr/libexec/PlistBuddy", ["-c", "Print :LSUIElement", info]);
  assert.equal(menuBar.stdout.trim(), "true");
  const { stderr: signingInfo } = await capture("codesign", ["-d", "--verbose=4", build.app]);
  const team = signingInfo.match(/^TeamIdentifier=([A-Z0-9]{10})$/mu)?.[1];
  assert.ok(team);
  const association = {
    applinks: { details: [{ appIDs: [team + ".com.qdis.bfb"], components: [{ "/": "/l/*" }] }] },
  };
  await writeFile(join(workspace, "apple-app-site-association"), JSON.stringify(association));
  assert.equal(association.applinks.details[0].appIDs[0], team + ".com.qdis.bfb");

  const damaged = join(workspace, "Damaged.app");
  await cp(build.app, damaged, { recursive: true });
  await appendFile(join(damaged, "Contents/Helpers/bfb"), "synthetic-signature-tamper");
  assert.equal((await probeJSON("installation", damaged)).code, "app_unavailable");

  daemon = spawn(build.helper, ["serve", state], {
    cwd: root,
    env: build.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout.pipe(process.stdout);
  daemon.stderr.pipe(process.stderr);
  daemonClosed = new Promise((resolve) => daemon.once("close", resolve));
  await until(async () => {
    try {
      return (await rpc("daemon.status")).payload?.status === "running";
    } catch {
      return false;
    }
  }, "private daemon readiness");
  assert.equal((await probeJSON("call", state, "daemon.status")).payload.status, "running");
  assert.equal(
    (await rpc("app.poll", { app_session_state: "available" })).error?.code,
    "peer_denied",
  );
  assert.equal(
    (await probeJSON("call", state, "app.poll", JSON.stringify({ app_session_state: "available" })))
      .code,
    "peer_denied",
  );

  await run("/usr/bin/open", [
    "-n",
    "-g",
    "--stdout",
    join(workspace, "app-native.log"),
    "--stderr",
    join(workspace, "app-native.log"),
    "-a",
    build.app,
  ]);
  const ready = await until(async () => {
    const snapshot = await rpc("synthetic.inspect");
    return readPID(snapshot) > 0 ? snapshot : false;
  }, "signed app authenticated polling");
  appPID = readPID(ready);
  const lockedSession = ready.payload.app_session_state === "locked";
  assert.ok(lockedSession || ready.payload.app_session_state === "available");
  assert.ok(ready.payload.log_entries.includes("child_alive"));
  assert.ok(ready.payload.log_entries.includes("observation:attached"));

  for (const url of [
    "bfb://launch/" + wake,
    selfHostedOnly ? "bfb://launch/" + wake : "https://launch.bfb.example/l/" + wake,
  ]) {
    await run("/usr/bin/open", ["-g", "-a", build.app, url]);
  }
  await until(
    async () => (await rpc("synthetic.inspect")).payload.recovery_pending === 2,
    "both link sources forwarded",
  );
  assert.equal((await rpc("synthetic.inspect")).payload.wake_intent_id, wake);
  for (const url of [
    "bfb://launch/" + local,
    "bfb://launch/" + wake + "?command=synthetic",
    "bfb://launch/" + wake + "%3Becho",
    "https://unassociated.example/l/" + wake,
  ]) {
    await run("/usr/bin/open", ["-g", "-a", build.app, url]);
  }
  await delay(400);
  assert.equal((await rpc("synthetic.inspect")).payload.recovery_pending, 2);

  const terminal = await rpc("synthetic.terminal", { terminal_intent_id: local });
  assert.ok(
    lockedSession
      ? terminal.error?.code === "session_locked"
      : !terminal.error || terminal.error.code === "consent_denied",
    JSON.stringify(terminal.error),
  );
  if (!terminal.error)
    await until(async () => {
      try {
        return (await readFile(join(state, "terminal-received"), "utf8")).includes(
          "synthetic UUID",
        );
      } catch {
        return false;
      }
    }, "real fixed UUID helper invocation");
  const notification = await rpc("synthetic.notify", { notification_id: wake });
  assert.ok(
    lockedSession
      ? notification.error?.code === "session_locked"
      : !notification.error || notification.error.code === "notification_denied",
    JSON.stringify(notification.error),
  );
  console.log(
    JSON.stringify({
      synthetic: true,
      terminal: terminal.error?.code ?? "terminal_opened",
      notifications: notification.error?.code ?? "notification_delivered",
    }),
  );

  for (let cycle = 0; cycle < (lockedSession ? 1 : 3); cycle++) {
    assert.equal((await probeJSON("terminate", String(appPID), build.app)).ok, true);
    await until(() => !running(appPID), "app-only graceful quit");
    const afterQuit = await rpc("synthetic.inspect");
    assert.ok(afterQuit.payload.log_entries.includes("child_alive"));
    assert.ok(afterQuit.payload.log_entries.includes("observation:attached"));
    assert.equal((await rpc("daemon.status")).payload.status, "running");
    const oldPID = appPID;
    appPID = undefined;
    const relaunched = await rpc("synthetic.terminal", { terminal_intent_id: local });
    if (relaunched.error?.code === "app_unavailable")
      console.log(
        JSON.stringify({
          relaunch: await rpc("synthetic.inspect"),
          app: await probeJSON("locate", build.app),
          console: await probeJSON("session"),
        }),
      );
    if (lockedSession) {
      assert.equal(relaunched.error?.code, "session_locked");
      assert.equal((await probeJSON("locate", build.app)).pid, 0);
    } else {
      assert.ok(
        !relaunched.error || relaunched.error.code === "consent_denied",
        JSON.stringify(relaunched.error),
      );
      const afterRelaunch = await until(async () => {
        const response = await rpc("synthetic.inspect");
        return readPID(response) !== oldPID ? response : false;
      }, "daemon-driven app relaunch");
      appPID = readPID(afterRelaunch);
      assert.ok(appPID > 0);
      assert.ok(afterRelaunch.payload.log_entries.includes("child_alive"));
    }
  }

  await socketCase(
    "partial",
    async (socket, response) => {
      const text = JSON.stringify(response) + "\n";
      socket.write(text.slice(0, 17));
      await delay(25);
      socket.end(text.slice(17));
    },
    "accept",
  );
  await socketCase(
    "wrong-id",
    (socket, response) => socket.end(JSON.stringify({ ...response, request_id: wake }) + "\n"),
    "invalid_request",
  );
  await socketCase(
    "wrong-method",
    (socket, response) => socket.end(JSON.stringify({ ...response, method: "runner.list" }) + "\n"),
    "invalid_request",
  );
  await socketCase(
    "wrong-direction",
    (socket, response) => socket.end(JSON.stringify({ ...response, direction: "request" }) + "\n"),
    "invalid_request",
  );
  await socketCase(
    "unknown-version",
    (socket, response) => socket.end(JSON.stringify({ ...response, schema_version: 2 }) + "\n"),
    "invalid_request",
  );
  await socketCase(
    "duplicate",
    (socket, response) =>
      socket.end(
        JSON.stringify(response).replace(
          '"schema_version":1',
          '"schema_version":1,"schema_version":1',
        ) + "\n",
      ),
    "invalid_request",
  );
  await socketCase(
    "extra-frame",
    (socket, response) => socket.end(JSON.stringify(response) + "\n{}\n"),
    "invalid_request",
  );
  await socketCase("oversized", (socket) => socket.end(" ".repeat(65537)), "invalid_request");
  await socketCase("utf8", (socket) => socket.end(Buffer.from([0xff, 10])), "invalid_request");
  await socketCase("public-socket", () => {}, "daemon_offline", { socketMode: 0o666 });
  await socketCase("public-root", () => {}, "daemon_offline", { rootMode: 0o755 });
  await socketCase("cancelled", () => {}, "cancelled", { cancel: true });
  const alias = join(workspace, "state-alias");
  await symlink(state, alias);
  assert.equal((await probeJSON("call", alias, "daemon.status")).code, "daemon_offline");
  if (lockedSession) {
    console.log("L04_LOCKED_SESSION_DIAGNOSTICS_PASSED");
    assert.ok(
      !process.argv.includes("--require-managed"),
      "Unlock this Mac to verify available-session app relaunch and Terminal delivery. Locked-session diagnostics are not full L04 certification.",
    );
  } else
    console.log(
      selfHostedOnly ? "L04_SELF_HOSTED_ACCEPTANCE_PASSED" : "L04_NATIVE_ACCEPTANCE_PASSED",
    );
  console.log(
    "Managed link profile: " +
      (selfHostedOnly ? "not tested" : "tested") +
      "; available-session relaunch: " +
      (lockedSession ? "not tested (Mac locked)" : "tested") +
      ". Public AASA/CDN discovery and notarized distribution are not claimed.",
  );
} finally {
  if (!appPID && probe && build) {
    try {
      appPID = (await probeJSON("locate", build.app)).pid || undefined;
    } catch {}
  }
  if (appPID && running(appPID)) {
    try {
      await probeJSON("terminate", String(appPID), build.app);
      await until(() => !running(appPID), "test app cleanup");
    } catch {
      process.kill(appPID, "SIGTERM");
    }
  }
  if (daemon && daemon.exitCode === null) daemon.kill("SIGTERM");
  if (daemonClosed) await daemonClosed;
  if (process.env.BFB_KEEP_MACOS_ACCEPTANCE === "1")
    console.log("Retained native acceptance: " + workspace + " " + build?.directory);
  else {
    await rm(workspace, { recursive: true, force: true });
    if (build) await rm(build.directory, { recursive: true, force: true });
  }
}

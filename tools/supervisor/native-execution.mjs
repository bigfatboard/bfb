// ABOUTME: Builds an isolated signed app and runs its real native execution integration harness.
// ABOUTME: Labels the no-GUI PTY diagnostic separately and never lets it satisfy Terminal acceptance.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildSignedApp, run } from "../macos/build.mjs";

assert.equal(process.platform, "darwin", "Native execution acceptance requires macOS");
assert.ok(
  process.argv.slice(2).every((value) => value === "--pty-diagnostic"),
  "Unknown native acceptance option",
);
const transport = process.argv.includes("--pty-diagnostic") ? "pty" : "terminal";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspace = await mkdtemp("/tmp/bfb-l04-execution-");
const state = join(workspace, "state");
await mkdir(state, { mode: 0o700 });
const build = await buildSignedApp({
  configuration: "Debug",
  testStateDirectory: state,
  helperPackage: "./internal/supervisor",
  helperTests: true,
});
const provider = join(workspace, "native-provider");
await run("go", ["build", "-o", provider, "./internal/supervisor/testdata/terminal-provider"]);
await run("codesign", [
  "--force",
  "--sign",
  build.identity,
  "--identifier",
  "com.tenira.bfb.synthetic-provider",
  "--options",
  "runtime",
  provider,
]);
await run("codesign", ["--verify", "--strict", provider]);
const capture = promisify(execFile);
let probe;
if (transport === "terminal") {
  probe = join(workspace, "native-probe");
  const sources = [
    "WireGenerated.swift",
    "WireCodec.swift",
    "LocalRPC.swift",
    "NativeActions.swift",
    "TerminalObjects.swift",
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
  const { stdout } = await capture(probe, ["session"], { timeout: 5000 });
  assert.equal(
    JSON.parse(stdout).session,
    "available",
    "An unlocked GUI session is required; PTY diagnostics cannot certify Terminal",
  );
}
console.log("Native execution workspace: " + workspace);
console.log("Native execution app: " + build.app);
try {
  await run(
    build.helper,
    ["-test.run=^TestSignedExecutionIntegration$", "-test.v", "-test.timeout=180s"],
    {
      env: {
        ...build.env,
        BFB_SIGNED_EXECUTION_TEST: transport,
        BFB_SIGNED_EXECUTION_PROVIDER: provider,
      },
    },
  );
  console.log(
    transport === "terminal"
      ? "L05_SIGNED_TERMINAL_EXECUTION_PASSED"
      : "L05_SIGNED_PTY_DIAGNOSTIC_PASSED (not Terminal certification)",
  );
} finally {
  if (probe) {
    const { stdout } = await capture(probe, ["locate", build.app], { timeout: 5000 });
    const { pid } = JSON.parse(stdout);
    if (pid > 0) {
      const { stdout } = await capture(probe, ["terminate", String(pid), build.app], {
        timeout: 5000,
      });
      assert.equal(JSON.parse(stdout).ok, true, "Owned native acceptance app did not quit");
    }
  }
}

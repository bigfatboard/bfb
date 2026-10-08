// ABOUTME: Builds bounded signed helper variants for the native local-execution authentication gate.
// ABOUTME: Exercises real socket peers without installing applications, changing credentials or requiring Terminal consent.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { run } from "../macos/build.mjs";

assert.equal(process.platform, "darwin", "Signed helper acceptance requires macOS");
const capture = promisify(execFile);
const { stdout } = await capture("security", ["find-identity", "-v", "-p", "codesigning"]);
const identity = stdout.match(/^\s*\d+\) ([A-F0-9]{40}) "Apple Development:/mu)?.[1];
assert.ok(
  identity,
  "A real Apple development signing identity is required; this gate is not skipped",
);
const workspace = await mkdtemp("/tmp/bfb-l05-helper-");
const executable = join(workspace, "helper");
const otherBuild = join(workspace, "other-build");
const otherID = join(workspace, "other-identifier");
const relaxed = join(workspace, "relaxed");
const adhoc = join(workspace, "ad-hoc");
await run("go", ["build", "-o", executable, "./internal/supervisor/testdata/helper-peer"]);
await run("go", [
  "build",
  "-ldflags",
  "-X main.variant=other",
  "-o",
  otherBuild,
  "./internal/supervisor/testdata/helper-peer",
]);
for (const path of [otherID, relaxed, adhoc]) await cp(executable, path, { errorOnExist: true });
const entitlements = join(workspace, "relaxed.plist");
await writeFile(
  entitlements,
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-dyld-environment-variables</key><true/></dict></plist>`,
  { mode: 0o600 },
);
for (const [path, identifier, signing, extra] of [
  [executable, "com.tenira.bfb.daemon", identity, []],
  [otherBuild, "com.tenira.bfb.daemon", identity, []],
  [otherID, "com.tenira.bfb.synthetic-other", identity, []],
  [relaxed, "com.tenira.bfb.daemon", identity, ["--entitlements", entitlements]],
  [adhoc, "com.tenira.bfb.daemon", "-", []],
]) {
  await run("codesign", [
    "--force",
    "--sign",
    signing,
    "--identifier",
    identifier,
    "--options",
    "runtime",
    ...extra,
    path,
  ]);
  await run("codesign", ["--verify", "--strict", path]);
}
await run(
  executable,
  ["serve", join(workspace, "state"), executable, executable, otherBuild, otherID, relaxed, adhoc],
  { timeout: 55_000 },
);

// ABOUTME: Builds and development-signs the native BFB app with its fixed embedded daemon helper.
// ABOUTME: Keeps Associated Domain configuration explicit and never modifies a running installation.

import assert from "node:assert/strict";
import { spawn, execFile, execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const capture = promisify(execFile);

export async function run(command, args, options = {}) {
  console.log("$ " + command + " " + args.join(" "));
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("close", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(command + " failed: " + (signal ?? code))),
    );
  });
}

export async function buildSignedApp({
  configuration = "Release",
  testStateDirectory,
  associatedHosts = [],
  provisioningProfile,
  helperPackage = "./cmd/bfb",
  helperTests = false,
} = {}) {
  assert.equal(process.platform, "darwin", "Native app building requires macOS");
  let profileTeam;
  if (associatedHosts.length > 0) {
    assert.ok(
      provisioningProfile,
      "Managed links require BFB_MACOS_PROFILE: an eligible Mac development profile for com.qdis.bfb. No Apple Developer account changes are made by this command.",
    );
    const { stdout: profile } = await capture("security", ["cms", "-D", "-i", provisioningProfile]);
    const part = (key) =>
      JSON.parse(
        execFileSync("plutil", ["-extract", key, "json", "-o", "-", "-"], {
          input: profile,
          stdio: ["pipe", "pipe", "pipe"],
        }).toString(),
      );
    assert.ok(
      part("Platform").includes("OSX"),
      "The provisioning profile must support native macOS",
    );
    const entitlements = part("Entitlements");
    profileTeam = entitlements["com.apple.developer.team-identifier"];
    assert.match(profileTeam, /^[A-Z0-9]{10}$/u);
    assert.equal(entitlements["com.apple.application-identifier"], profileTeam + ".com.qdis.bfb");
    const allowed = entitlements["com.apple.developer.associated-domains"];
    assert.ok(
      allowed === "*" ||
        (Array.isArray(allowed) &&
          (allowed.includes("*") ||
            associatedHosts.every((host) => allowed.includes("applinks:" + host)))),
      "The profile must authorize every configured associated domain",
    );
  }
  const expected = (await readFile(join(root, ".xcode-version"), "utf8")).trim();
  const env = {
    ...process.env,
    DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer",
  };
  const { stdout: version } = await capture("xcodebuild", ["-version"], { env });
  assert.equal(version.split(/\r?\n/u)[0], "Xcode " + expected);
  const { stdout: identities } = await capture("security", [
    "find-identity",
    "-v",
    "-p",
    "codesigning",
  ]);
  const identity = identities.match(/^\s*\d+\) ([A-F0-9]{40}) "Apple Development:/mu)?.[1];
  assert.ok(
    identity,
    "An Apple development signing identity is required; this gate is not skipped",
  );
  const directory = await mkdtemp(join(tmpdir(), "bfb-macos-build-"));
  const derived = join(directory, "derived");
  await run(
    "xcodebuild",
    [
      "-project",
      "apps/macos/BFB.xcodeproj",
      "-scheme",
      "BFB",
      "-configuration",
      configuration,
      "-destination",
      "platform=macOS",
      "-derivedDataPath",
      derived,
      "CODE_SIGNING_ALLOWED=NO",
      "ENABLE_DEBUG_DYLIB=NO",
      "build",
    ],
    { env },
  );
  const app = join(directory, "BFB.app");
  await cp(join(derived, "Build/Products", configuration, "BFB.app"), app, {
    recursive: true,
    errorOnExist: true,
  });
  const helper = join(app, "Contents/Helpers/bfb");
  await mkdir(dirname(helper), { recursive: true });
  assert.ok(!helperTests || configuration === "Debug", "A test helper is a Debug-only fixture");
  await run("go", [...(helperTests ? ["test", "-c"] : ["build"]), "-o", helper, helperPackage]);
  await run("codesign", [
    "--force",
    "--sign",
    identity,
    "--identifier",
    "com.tenira.bfb.daemon",
    "--options",
    "runtime",
    helper,
  ]);
  if (provisioningProfile) {
    const { stderr: info } = await capture("codesign", ["-d", "--verbose=4", helper]);
    assert.equal(
      info.match(/^TeamIdentifier=([A-Z0-9]{10})$/mu)?.[1],
      profileTeam,
      "Signing identity and provisioning profile teams must match",
    );
    await cp(provisioningProfile, join(app, "Contents/embedded.provisionprofile"));
  }
  if (testStateDirectory) {
    assert.equal(configuration, "Debug", "Isolated app state is an explicit Debug-only fixture");
    assert.ok(testStateDirectory.startsWith("/tmp/bfb-l04-"));
    await run("/usr/libexec/PlistBuddy", [
      "-c",
      "Add :BFBTestStateDirectory string " + testStateDirectory,
      join(app, "Contents/Info.plist"),
    ]);
    await mkdir(join(app, "Contents/Resources"), { recursive: true });
    await writeFile(
      join(app, "Contents/Resources/native-test-state.json"),
      JSON.stringify({ directory: testStateDirectory }),
    );
  }
  for (const host of associatedHosts) assert.match(host, /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/u);
  const entitlements = join(directory, "BFB.entitlements");
  const domains = associatedHosts
    .map((host) => `<string>applinks:${host}?mode=developer</string>`)
    .join("");
  const restricted = domains
    ? `<key>com.apple.developer.associated-domains</key><array>${domains}</array><key>com.apple.application-identifier</key><string>${profileTeam}.com.qdis.bfb</string><key>com.apple.developer.team-identifier</key><string>${profileTeam}</string>`
    : "";
  await writeFile(
    entitlements,
    `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.automation.apple-events</key><true/>${restricted}</dict></plist>`,
  );
  await run("codesign", [
    "--force",
    "--sign",
    identity,
    "--identifier",
    "com.qdis.bfb",
    "--options",
    "runtime",
    "--entitlements",
    entitlements,
    app,
  ]);
  await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  return { app, helper, directory, identity, env };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const build = await buildSignedApp();
  console.log("Development-signed BFB app: " + build.app);
  console.log(
    "Nothing was installed or deployed. Keep the bundle at a stable location before starting its runner.",
  );
}

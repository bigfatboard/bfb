// ABOUTME: Builds and signs the managed-link BFB app locally with the development profile.
// ABOUTME: Writes deterministic signing-result.json; notarization stays a rollout step.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { format, resolveConfig } from "prettier";

import { buildSignedApp } from "../macos/build.mjs";

const root = new URL("../..", import.meta.url).pathname;
const evidence = join(root, "docs/work-packages/evidence/WP-G02/signing-result.json");

const profilePath = process.env.BFB_MACOS_PROFILE;
assert.ok(profilePath, "BFB_MACOS_PROFILE carries the Mac development profile for managed links");

const signed = await buildSignedApp({
  associatedHosts: ["launch.bfb.example"],
  provisioningProfile: profilePath,
});
try {
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", signed.app], {
    stdio: "pipe",
  });
  const helperInfo = spawnSync("codesign", ["-d", "--verbose=4", signed.helper], {
    encoding: "utf8",
  });
  assert.equal(helperInfo.status, 0, "helper display succeeds");
  assert.match(
    String(helperInfo.stderr),
    /Identifier=com\.tenira\.bfb\.daemon/,
    "helper carries its identifier",
  );
  const appInfo = spawnSync("codesign", ["-d", "--verbose=4", signed.app], { encoding: "utf8" });
  assert.equal(appInfo.status, 0, "app display succeeds");
  assert.match(String(appInfo.stderr), /Identifier=com\.qdis\.bfb/, "app carries its identifier");
  const entitlements = spawnSync("codesign", ["-d", "--entitlements", "-", signed.app], {
    encoding: "utf8",
  });
  assert.equal(entitlements.status, 0, "entitlement display succeeds");
  assert.match(
    String(entitlements.stdout),
    /applinks:launch\.bfb\.example\?mode=developer/,
    "managed entitlement authorizes the dev link",
  );
  assert.ok(
    existsSync(join(signed.app, "Contents/Helpers/bfb")),
    "signed bundle embeds the hook launcher",
  );
  assert.ok(
    existsSync(join(signed.app, "Contents/embedded.provisionprofile")),
    "signed bundle embeds the profile",
  );
} finally {
  rmSync(signed.directory, { recursive: true, force: true });
}

const result = {
  release: "bfb-v0.1-g02",
  app_identifier: "com.qdis.bfb",
  helper_identifier: "com.tenira.bfb.daemon",
  hook_launcher: "Contents/Helpers/bfb __launch <terminal-intent-uuid>",
  custom_scheme: "bfb://launch/<cloud-wake-ULID>",
  managed_link: "applinks:launch.bfb.example?mode=developer",
  deep_strict_verify: "passed",
  profile: "development",
  notarization: "prepared rollout step (docs/release/rollout.md), not run locally",
};
const options = (await resolveConfig(evidence)) ?? {};
await writeFile(
  evidence,
  await format(JSON.stringify(result, null, 2), { ...options, parser: "json" }),
);
console.log("G02_SIGN managed-link app builds, signs, and verifies locally");

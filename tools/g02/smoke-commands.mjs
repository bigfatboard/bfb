// ABOUTME: Runs the post-deploy authenticated smoke against a deployed origin.
// ABOUTME: Fails closed without a credential; prints statuses, never secrets.

import assert from "node:assert/strict";

const args = process.argv.slice(2);
const originFlag = args.indexOf("--origin");
if (originFlag === -1 || !args[originFlag + 1]) {
  console.error("usage: node tools/g02/smoke-commands.mjs --origin https://bfb.example.test");
  process.exit(2);
}
const origin = args[originFlag + 1];
// Loopback http exists so the same script smokes local staging workers;
// anything else must be https so the credential never crosses the network.
assert.match(
  origin,
  /^(?:https:\/\/[a-z0-9]+(?:[.-][a-z0-9]+)*|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)$/u,
  "smoke needs an https origin (http only for localhost)",
);

// The smoke proves authenticated handlers serve, not just that anonymous
// requests are rejected, so a valid owner-minted CLI credential is required.
// It arrives via the environment so it never lands in shell history or logs.
const credential = process.env.BFB_SMOKE_CREDENTIAL ?? "";
if (!/^bfb_cli_[A-Za-z0-9_-]{43}$/u.test(credential)) {
  console.error("BFB_SMOKE_CREDENTIAL must hold a CLI credential for the target origin");
  process.exit(2);
}

async function get(path, init = {}) {
  const response = await fetch(origin + path, { redirect: "manual", ...init });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

const health = await get("/healthz");
assert.equal(health.status, 200, "healthz answers");
assert.equal(health.body?.ok, true, "healthz reports ok");
assert.equal(health.body?.worker_first, true, "healthz reports worker-first routing");
console.log(`smoke healthz ok environment=${health.body?.environment}`);

const version = await get("/api/v1/cli/version");
assert.equal(version.status, 200, "cli version answers");
assert.equal(version.body?.api_version, "1", "cli api version frozen");
assert.equal(version.body?.wire_protocol, "bfb-wire/1", "cli wire protocol frozen");
assert.equal(version.body?.cli_min_version, "0.1.0", "cli minimum version frozen");
console.log("smoke cli/version ok");

const session = await get("/api/v1/cli/session");
assert.equal(session.status, 401, "cli session without a credential is rejected");
console.log("smoke cli/session rejected without credential");

// A well-formed but unknown key exercises the credential lookup path;
// the literal redacted placeholder never reaches the server regex.
const forged = await get("/api/v1/cli/session", {
  headers: { authorization: `Bearer bfb_cli_${"0".repeat(43)}` },
});
assert.equal(forged.status, 401, "cli session with a bad credential is rejected");
console.log("smoke cli/session rejected with bad credential");

// A valid credential must reach the handler: a deployment whose
// authenticated routes fail passes every check above and fails here.
const authed = await get("/api/v1/cli/session", {
  headers: { authorization: `Bearer ${credential}` },
});
assert.equal(authed.status, 200, "cli session with a valid credential answers");
assert.equal(typeof authed.body?.workspace_id, "string", "session names its workspace");
assert.equal(typeof authed.body?.binding_id, "string", "session names its binding");
assert.ok(Array.isArray(authed.body?.scopes), "session names its scopes");
console.log("smoke cli/session ok with valid credential");

const projects = await get("/api/v1/cli/projects", {
  headers: { authorization: `Bearer ${credential}` },
});
assert.equal(projects.status, 200, "cli projects with a valid credential answers");
assert.ok(Array.isArray(projects.body?.projects), "projects lists records");
console.log("smoke cli/projects ok with valid credential");

console.log(`Post-deploy smoke passed for ${origin}`);

// ABOUTME: Runs the post-deploy authenticated smoke against a deployed origin.
// ABOUTME: Fails closed on any unauthenticated success or shape drift; prints no secrets.

import assert from "node:assert/strict";

const args = process.argv.slice(2);
const originFlag = args.indexOf("--origin");
if (originFlag === -1 || !args[originFlag + 1]) {
  console.error("usage: node tools/g02/smoke-commands.mjs --origin https://bfb.example.test");
  process.exit(2);
}
const origin = args[originFlag + 1];
assert.match(origin, /^https:\/\/[a-z0-9]+(?:[.-][a-z0-9]+)*$/u, "smoke needs an https origin");

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

const exchange = await get("/api/v1/cli/session", {
  headers: { authorization: "Bearer bfb_cli_synthetic-invalid-credential" },
});
assert.equal(exchange.status, 401, "cli session with a bad credential is rejected");
console.log("smoke cli/session rejected with bad credential");

console.log(`Post-deploy smoke passed for ${origin}`);

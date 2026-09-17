// ABOUTME: Generates visibly synthetic L06 hook-receipt and journal-status protocol fixtures.
// ABOUTME: Keeps hook payload boundaries deterministic across the fixture matrix check.

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import prettierConfig from "../../prettier.config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const check = process.argv.includes("--check");
const requestId = "01JBFB06H00KRECE1PT0000000";
const eventId = "01JBFB06H00KEVENT100000000";
const base = {
  schema_version: 1,
  request_id: requestId,
  direction: "response",
};
const accepted = {
  ...base,
  method: "hook.ingest",
  payload: { hook_status: "accepted", hook_event_id: eventId, hook_sequence: 7 },
};
const fixtures = [];
function fixture(schema, suffix, value, category) {
  fixtures.push([
    `${category ? "invalid" : "valid"}/${schema}.l06-${suffix}.json`,
    schema,
    value,
    category,
  ]);
}
fixture("local-rpc", "hook-accepted", accepted);
fixture("local-rpc", "hook-duplicate", {
  ...accepted,
  payload: { hook_status: "duplicate", hook_event_id: eventId },
});
fixture("local-rpc", "hook-quarantined", {
  ...accepted,
  payload: { hook_status: "quarantined", hook_code: "session_conflict" },
});
fixture("local-rpc", "hook-rejected", {
  ...accepted,
  payload: { hook_status: "rejected", hook_code: "correlation_rejected" },
});
fixture("local-rpc", "hook-inbox", {
  ...accepted,
  payload: { hook_status: "inbox" },
});
fixture("local-rpc", "hook-status", {
  ...base,
  method: "hook.status",
  payload: { hook_pending: 3, hook_quarantined: 1, telemetry_degraded: false },
});
fixture("local-rpc", "hook-degraded", {
  ...base,
  method: "hook.status",
  payload: {
    hook_pending: 0,
    hook_quarantined: 2,
    telemetry_degraded: true,
    degraded_reason: "inbox_auth_failed",
  },
});
for (const [suffix, value, category] of [
  ["hook-status-value", { ...accepted, payload: { hook_status: "stored" } }, "type_mismatch"],
  ["hook-event-value", { ...accepted, payload: { ...accepted.payload, hook_event_id: "not-a-ulid" } }, "bound_exceeded"],
  [
    "hook-method",
    { ...accepted, method: "daemon.status" },
    "type_mismatch",
  ],
  [
    "hook-direction",
    { ...accepted, direction: "request" },
    "type_mismatch",
  ],
  [
    "hook-status-method",
    {
      ...base,
      method: "hook.ingest",
      payload: { hook_pending: 1, hook_quarantined: 0, telemetry_degraded: false },
    },
    "type_mismatch",
  ],
  [
    "hook-extra",
    { ...accepted, payload: { ...accepted.payload, hook_token: "synthetic-secret" } },
    "additional_field",
  ],
]) {
  fixture("local-rpc", suffix, value, category);
}

async function output(path, value) {
  const contents = await format(JSON.stringify(value, null, 2), {
    ...prettierConfig,
    parser: "json",
  });
  if (check) assert.equal(await readFile(resolve(root, path), "utf8"), contents, `${path} drifted`);
  else await writeFile(resolve(root, path), contents);
}
for (const [path, , value] of fixtures) await output("protocol/fixtures/v1/" + path, value);
const matrixPath = "protocol/fixtures/v1/matrix.json";
const matrix = JSON.parse(await readFile(resolve(root, matrixPath), "utf8"));
const owned = fixtures.map(([path, schema, , category]) => ({
  path,
  schema,
  expect: category ? "reject" : "accept",
  ...(category ? { category } : {}),
}));
if (check)
  assert.deepEqual(
    matrix.fixtures.filter((entry) => entry.path.includes(".l06-")),
    owned,
  );
else
  await output(matrixPath, {
    ...matrix,
    fixtures: [...matrix.fixtures.filter((entry) => !entry.path.includes(".l06-")), ...owned],
  });
console.log(`L06 fixtures ${check ? "checked" : "generated"}: ${fixtures.length}`);

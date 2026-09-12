// ABOUTME: Generates visibly synthetic L05 local-assignment and registration protocol fixtures.
// ABOUTME: Keeps private correlation, one-time UUID and response-only assignment boundaries deterministic.

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import prettierConfig from "../../prettier.config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const check = process.argv.includes("--check");
const claim = JSON.parse(
  await readFile(
    resolve(root, "protocol/fixtures/v1/valid/launch-claim-result.c09-synthetic.json"),
    "utf8",
  ),
);
const intent = "e0da52a9-d0cb-47d8-867b-e08f684b9001";
const assignment = {
  schema_version: 1,
  terminal_intent_id: intent,
  claim,
  provider_identity_hash: "sha256:" + "a".repeat(64),
  correlation_token: Buffer.alloc(32, "S").toString("base64url"),
  supervisor: {
    pid: 1234,
    start_identity: "123456:1000",
    executable_hash: "sha256:" + "b".repeat(64),
  },
};
const request = {
  schema_version: 1,
  request_id: claim.specification.launch_id,
  method: "execution.register",
  direction: "request",
  payload: { terminal_intent_id: intent },
};
const response = {
  ...request,
  direction: "response",
  payload: { execution_assignment: assignment },
};
const fixtures = [];
function fixture(schema, suffix, value, category) {
  fixtures.push([
    `${category ? "invalid" : "valid"}/${schema}.l05-${suffix}.json`,
    schema,
    value,
    category,
  ]);
}
fixture("local-execution-assignment", "synthetic", assignment);
fixture("local-rpc", "registration-request", request);
fixture("local-rpc", "registration-response", response);
const observation = {
  schema_version: 1,
  event_id: claim.specification.launch_id,
  run_execution_id: claim.assignment.run_execution_id,
  assignment_generation: claim.assignment.assignment_generation,
  sequence: 1,
  kind: "execution_attached",
  occurred_at: "2026-09-12T12:00:03Z",
  capture_origin: "runner_observed",
  process_state: "live",
  provider_start: "observed",
};
const detached = {
  ...observation,
  kind: "execution_detached",
  process_state: "unknown",
  diagnostic: "containment_unknown",
};
const blocked = {
  ...observation,
  kind: "launch_blocked",
  process_state: "never_started",
  provider_start: "unobserved",
  diagnostic: "expired_intent",
};
for (const [name, value] of [
  ["attached", observation],
  ["heartbeat", { ...observation, kind: "heartbeat" }],
  ["detached", detached],
  ["ended", { ...observation, kind: "execution_ended", process_state: "gone" }],
  [
    "ended-unobserved",
    {
      ...observation,
      kind: "execution_ended",
      process_state: "gone",
      provider_start: "unobserved",
    },
  ],
  ["blocked", blocked],
])
  fixture("local-execution-observation", name, value);
for (const [name, value, category] of [
  ["working", { ...observation, activity: "working" }, "additional_field"],
  ["result", { ...observation, result: "accepted" }, "additional_field"],
  ["shell", { ...observation, argv: ["synthetic"] }, "shell_data"],
  ["lease", { ...observation, local_lock_id: claim.specification.launch_id }, "additional_field"],
  ["origin", { ...observation, capture_origin: "agent_reported" }, "type_mismatch"],
  ["no-image", { ...observation, provider_start: "unobserved" }, "type_mismatch"],
  ["heartbeat-gone", { ...observation, kind: "heartbeat", process_state: "gone" }, "type_mismatch"],
  [
    "heartbeat-diagnostic",
    { ...observation, kind: "heartbeat", diagnostic: "containment_unknown" },
    "schema_invalid",
  ],
  ["detached-live", { ...detached, process_state: "live" }, "type_mismatch"],
  ["detached-reason", { ...detached, diagnostic: undefined }, "missing_field"],
  ["ended-live", { ...observation, kind: "execution_ended" }, "type_mismatch"],
  ["blocked-live", { ...blocked, process_state: "live" }, "type_mismatch"],
  ["blocked-image", { ...blocked, provider_start: "observed" }, "type_mismatch"],
  ["blocked-reason", { ...blocked, diagnostic: undefined }, "missing_field"],
  ["private-reason", { ...blocked, diagnostic: "/synthetic/private" }, "type_mismatch"],
  ["no-sequence", { ...observation, sequence: 0 }, "bound_exceeded"],
  ["unsafe-sequence", { ...observation, sequence: 9007199254740992 }, "bound_exceeded"],
  ["bad-generation", { ...observation, assignment_generation: 0 }, "bound_exceeded"],
])
  fixture("local-execution-observation", name, value, category);
const authorize = {
  ...request,
  method: "execution.authorize",
  payload: { terminal_intent_id: intent, local_lock_id: claim.specification.launch_id },
};
const group = {
  ...authorize,
  method: "execution.group",
  payload: { ...authorize.payload, process_group_id: 1235 },
};
const authorized = {
  ...authorize,
  direction: "response",
  payload: {
    final_authorization: {
      schema_version: 1,
      launch_id: claim.specification.launch_id,
      run_execution_id: claim.assignment.run_execution_id,
      assignment_generation: claim.assignment.assignment_generation,
      decision: "authorized",
      authorized_at: "2026-09-12T12:00:03Z",
    },
  },
};
fixture("local-rpc", "authorize-request", authorize);
fixture("local-rpc", "authorize-response", authorized);
fixture("local-rpc", "group-request", group);
fixture("local-rpc", "group-response", { ...group, direction: "response", payload: {} });
fixture(
  "local-rpc",
  "group-other-method",
  { ...group, method: "execution.register" },
  "type_mismatch",
);
fixture(
  "local-rpc",
  "group-response-identity",
  { ...group, direction: "response" },
  "type_mismatch",
);
fixture(
  "local-rpc",
  "group-without-lock",
  { ...group, payload: { terminal_intent_id: intent, process_group_id: 1235 } },
  "missing_field",
);
fixture(
  "local-rpc",
  "group-unsafe-pid",
  { ...group, payload: { ...group.payload, process_group_id: 1 } },
  "bound_exceeded",
);
fixture(
  "local-rpc",
  "authorize-supplied-decision",
  { ...authorized, direction: "request" },
  "type_mismatch",
);
fixture(
  "local-rpc",
  "authorize-other-method",
  { ...authorized, method: "daemon.status" },
  "type_mismatch",
);
fixture(
  "local-rpc",
  "authorize-lock-other-method",
  { ...authorize, method: "checkout.link" },
  "type_mismatch",
);
fixture(
  "local-execution-assignment",
  "shell",
  { ...assignment, argv: ["synthetic"] },
  "shell_data",
);
fixture(
  "local-execution-assignment",
  "path",
  { ...assignment, local_path: "/synthetic/private" },
  "additional_field",
);
fixture(
  "local-execution-assignment",
  "cloud-wake",
  { ...assignment, terminal_intent_id: claim.specification.launch_id },
  "bound_exceeded",
);
fixture(
  "local-execution-assignment",
  "short-correlation",
  { ...assignment, correlation_token: "synthetic-short" },
  "bound_exceeded",
);
fixture(
  "local-execution-assignment",
  "missing-supervisor",
  { ...assignment, supervisor: undefined },
  "missing_field",
);
fixture(
  "local-execution-assignment",
  "invalid-pid",
  { ...assignment, supervisor: { ...assignment.supervisor, pid: 0 } },
  "bound_exceeded",
);
fixture(
  "local-execution-assignment",
  "process-path",
  { ...assignment, supervisor: { ...assignment.supervisor, executable: "/synthetic/bfb" } },
  "shell_data",
);
fixture("local-rpc", "assignment-request", { ...response, direction: "request" }, "type_mismatch");
fixture(
  "local-rpc",
  "assignment-method",
  { ...response, method: "daemon.status" },
  "type_mismatch",
);
fixture(
  "local-rpc",
  "assignment-nested-shell",
  { ...response, payload: { execution_assignment: { ...assignment, command: "synthetic" } } },
  "shell_data",
);

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
    matrix.fixtures.filter((entry) => entry.path.includes(".l05-")),
    owned,
  );
else
  await output(matrixPath, {
    ...matrix,
    fixtures: [...matrix.fixtures.filter((entry) => !entry.path.includes(".l05-")), ...owned],
  });
console.log(`L05 fixtures ${check ? "checked" : "generated"}: ${fixtures.length}`);

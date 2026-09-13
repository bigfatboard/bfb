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
const recovery = { ...request, method: "execution.recover" };
fixture("local-rpc", "recovery-request", recovery);
fixture("local-rpc", "recovery-response", { ...recovery, direction: "response", payload: {} });
for (const [suffix, value, category] of [
  ["missing-payload", { ...recovery, payload: undefined }, "missing_field"],
  ["missing-intent", { ...recovery, payload: {} }, "missing_field"],
  [
    "cloud-intent",
    { ...recovery, payload: { terminal_intent_id: claim.specification.launch_id } },
    "bound_exceeded",
  ],
  [
    "supplied-pid",
    { ...recovery, payload: { ...recovery.payload, daemon_pid: 1234 } },
    "additional_field",
  ],
  ["response-target", { ...recovery, direction: "response" }, "bound_exceeded"],
  ["event", { ...recovery, direction: "event" }, "type_mismatch"],
])
  fixture("local-rpc", "recovery-" + suffix, value, category);
const control = {
  schema_version: 1,
  terminal_intent_id: intent,
  control_id: claim.specification.launch_id,
  run_execution_id: claim.assignment.run_execution_id,
  assignment_generation: claim.assignment.assignment_generation,
  action: "interrupt",
  authorized_at: "2026-09-12T12:00:03Z",
  expires_at: "2026-09-12T12:00:33Z",
};
const controlPoll = { ...request, method: "execution.control" };
const controlReply = {
  ...controlPoll,
  direction: "response",
  payload: { execution_control: control },
};
const controlResult = {
  ...request,
  method: "execution.control_result",
  payload: {
    terminal_intent_id: intent,
    control_id: control.control_id,
    control_disposition: "applied",
  },
};
for (const action of ["interrupt", "terminate", "cancel"])
  fixture("local-execution-control", action, { ...control, action });
fixture("local-rpc", "control-poll", controlPoll);
fixture("local-rpc", "control-reply", controlReply);
fixture("local-rpc", "control-empty", { ...controlReply, payload: {} });
fixture("local-rpc", "control-result-empty", {
  ...controlResult,
  direction: "response",
  payload: {},
});
for (const control_disposition of ["applied", "local_rejected", "delivery_unknown"])
  fixture("local-rpc", "control-result-" + control_disposition, {
    ...controlResult,
    payload: { ...controlResult.payload, control_disposition },
  });
for (const [name, value, category] of [
  ["signal", { ...control, signal: 9 }, "additional_field"],
  ["pid", { ...control, process_group_id: 1235 }, "additional_field"],
  ["argv", { ...control, argv: ["synthetic"] }, "shell_data"],
  ["resume", { ...control, action: "resume" }, "type_mismatch"],
  ["focus", { ...control, action: "focus" }, "type_mismatch"],
  ["no-time", { ...control, authorized_at: undefined }, "missing_field"],
  ["no-intent", { ...control, terminal_intent_id: undefined }, "missing_field"],
  ["cloud-intent", { ...control, terminal_intent_id: control.control_id }, "bound_exceeded"],
  ["generation", { ...control, assignment_generation: 0 }, "bound_exceeded"],
])
  fixture("local-execution-control", name, value, category);
for (const [name, value, category] of [
  ["request", { ...controlReply, direction: "request" }, "type_mismatch"],
  ["method", { ...controlReply, method: "execution.register" }, "type_mismatch"],
  ["result-response", { ...controlResult, direction: "response" }, "type_mismatch"],
  ["result-method", { ...controlResult, method: "execution.control" }, "type_mismatch"],
  [
    "result-no-id",
    { ...controlResult, payload: { ...controlResult.payload, control_id: undefined } },
    "missing_field",
  ],
  [
    "result-no-outcome",
    { ...controlResult, payload: { ...controlResult.payload, control_disposition: undefined } },
    "missing_field",
  ],
  [
    "result-no-intent",
    { ...controlResult, payload: { ...controlResult.payload, terminal_intent_id: undefined } },
    "missing_field",
  ],
  [
    "result-fake",
    { ...controlResult, payload: { ...controlResult.payload, control_disposition: "completed" } },
    "type_mismatch",
  ],
])
  fixture("local-rpc", "control-" + name, value, category);
const focus = { ...control, tty: "/dev/ttys001" };
delete focus.action;
const focusReply = {
  ...request,
  method: "app.poll",
  direction: "response",
  payload: {
    app_delivery_id: control.control_id,
    app_action: "focus_terminal",
    execution_focus: focus,
  },
};
const focusCheck = {
  ...request,
  method: "app.focus_check",
  payload: { app_delivery_id: control.control_id },
};
fixture("local-execution-focus", "synthetic", focus);
fixture("local-rpc", "focus-delivery", focusReply);
fixture("local-rpc", "focus-check", focusCheck);
fixture("local-rpc", "focus-checked", { ...focusCheck, direction: "response", payload: {} });
fixture("local-rpc", "focus-result", {
  ...request,
  method: "app.complete",
  payload: { app_delivery_id: control.control_id, app_result: "terminal_focused" },
});
for (const [name, value, category] of [
  ["pid", { ...focus, pid: 1234 }, "additional_field"],
  ["command", { ...focus, command: "synthetic" }, "shell_data"],
  ["path", { ...focus, tty: "/synthetic/path" }, "type_mismatch"],
  ["newline", { ...focus, tty: "/dev/ttys001\n" }, "type_mismatch"],
  ["missing-time", { ...focus, authorized_at: undefined }, "missing_field"],
  ["generation", { ...focus, assignment_generation: 0 }, "bound_exceeded"],
])
  fixture("local-execution-focus", name, value, category);
for (const [name, value, category] of [
  ["request", { ...focusReply, direction: "request" }, "type_mismatch"],
  ["method", { ...focusReply, method: "execution.control" }, "type_mismatch"],
  [
    "action",
    { ...focusReply, payload: { ...focusReply.payload, app_action: "open_terminal" } },
    "type_mismatch",
  ],
  [
    "no-delivery",
    { ...focusReply, payload: { ...focusReply.payload, app_delivery_id: undefined } },
    "missing_field",
  ],
  ["check-no-delivery", { ...focusCheck, payload: {} }, "missing_field"],
  [
    "check-retarget",
    { ...focusCheck, payload: { ...focusCheck.payload, terminal_intent_id: intent } },
    "additional_field",
  ],
  [
    "check-reply-target",
    { ...focusCheck, direction: "response", payload: { ...focusCheck.payload } },
    "bound_exceeded",
  ],
])
  fixture("local-rpc", "focus-" + name, value, category);
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

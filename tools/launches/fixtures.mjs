// ABOUTME: Generates bounded synthetic C09 wire fixtures shared by TypeScript and Go decoders.
// ABOUTME: Check mode enforces deterministic payloads and matrix ownership without rewriting files.

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

import prettierConfig from "../../prettier.config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const check = process.argv.includes("--check");
const id = (number) => `01K0000000000000000000${String(number).padStart(4, "0")}`;
const digest = `sha256:${"a".repeat(64)}`;
const now = "2026-09-12T12:00:00.000Z";
const expiry = "2026-09-12T12:02:00.000Z";
const binding = { run_execution_id: id(1), assignment_generation: 1 };
const policy = {
  allowed_providers: ["fake"],
  allow_agent_root_propose: false,
  allow_pass_to_agent: true,
  allow_run_overrides: false,
};
const execution = {
  provider: "fake",
  mode: "interactive",
  model: "synthetic",
  effort: "high",
  approval_policy: "never",
  filesystem_policy: "read_only",
  context_injection: "session_start_additional_context",
  initial_turn_transport: "provider_prompt",
  required_capabilities: [
    "launch.interactive",
    "filesystem.read_only",
    "approval.never",
    "context.session_start",
    "prompt.initial_constant",
    "hooks.session_start",
    "mcp.stdio",
  ],
};
const versions = {
  workspace_policy_version: 2,
  project_policy_version: 2,
  repository_config_version: 2,
  agent_profile_version: 1,
};
const start = {
  schema_version: 1,
  idempotency_key: "c09-start-synthetic",
  task_id: id(2),
  expected_task_version: 1,
  runner_id: id(3),
  checkout_id: id(4),
  agent_profile_id: id(5),
  ...versions,
};
const snapshot = {
  schema_version: 1,
  workspace_id: id(6),
  project_id: id(7),
  task_id: start.task_id,
  agent_profile_id: start.agent_profile_id,
  ...versions,
  snapshot_generation: 1,
  physical_worktree_hash: digest,
  repository_identity_hash: digest,
  provider_manifest_id: digest,
  provider_version: "1.0.0",
  repository_config_hash: digest,
  workspace_policy: policy,
  project_policy: policy,
  repository_policy: policy,
  execution_config: execution,
};
const specification = {
  schema_version: 1,
  launch_id: id(8),
  run_id: id(9),
  ...binding,
  task_id: start.task_id,
  runner_id: start.runner_id,
  checkout_id: start.checkout_id,
  agent_profile_id: start.agent_profile_id,
  config_snapshot_id: id(10),
  config_snapshot_hash: digest,
  execution_config: execution,
  expires_at: expiry,
};
const assignment = {
  schema_version: 1,
  ...binding,
  runner_id: start.runner_id,
  run_id: specification.run_id,
  task_id: start.task_id,
  project_id: snapshot.project_id,
  workspace_id: snapshot.workspace_id,
  checkout_id: start.checkout_id,
  created_at: now,
};
const claimed = {
  schema_version: 1,
  specification,
  snapshot,
  assignment,
  fencing_generation: 1,
  lease_expires_at: "2026-09-12T12:00:45.000Z",
};
const supervisor = { pid: 1234, start_identity: "123456:1000", executable_hash: digest };
const final = {
  schema_version: 1,
  launch_id: specification.launch_id,
  ...binding,
  fencing_generation: 1,
  config_snapshot_id: specification.config_snapshot_id,
  config_snapshot_hash: digest,
  repository_config_hash: digest,
  physical_worktree_hash: digest,
  supervisor,
  local_lock_id: id(11),
};
const observation = {
  schema_version: 1,
  ...binding,
  fencing_generation: 1,
  sequence: 1,
  observed_at: now,
  operation: "renew",
  supervisor,
  local_lock_id: final.local_lock_id,
  owned_group_id: 1235,
  owned_group_start_identity: "123457:1000",
  supervisor_state: "verified",
  group_state: "live",
  lock_state: "held",
  descendants_state: "contained",
  recovery_local: false,
};
const control = {
  schema_version: 1,
  idempotency_key: "c09-control-synthetic",
  runner_id: start.runner_id,
  ...binding,
  action: "interrupt",
};
const controlClaim = {
  schema_version: 1,
  control_id: id(12),
  idempotency_key: "c09-control-claim",
  ...binding,
  action: control.action,
};
const disposition = {
  schema_version: 1,
  control_id: controlClaim.control_id,
  idempotency_key: controlClaim.idempotency_key,
  ...binding,
  disposition: "applied",
};
const tighten = {
  schema_version: 1,
  launch_id: specification.launch_id,
  ...binding,
  fencing_generation: 1,
  config_snapshot_hash: digest,
  repository_config_hash: digest,
  document: { allowed_providers: ["fake"], allow_run_overrides: false },
};
const documents = [
  ["launch-start-request", start],
  ["launch-snapshot", snapshot],
  ["launch-claim-result", claimed],
  ["launch-final-request", final],
  ["checkout-lease-observation", observation],
  ["run-control-request", control],
  ["run-control-claim", controlClaim],
  ["run-control-disposition", disposition],
  ["launch-reject-request", { schema_version: 1, launch_id: specification.launch_id, ...binding }],
  ["launch-tighten-request", tighten],
  ["launch-wake-request", { schema_version: 1, launch_id: specification.launch_id }],
  ["launch-wake-redemption", { schema_version: 1, wake_intent_id: id(13) }],
  ["launch-specification", specification],
  ["run-control-reference", { schema_version: 1, control_id: controlClaim.control_id }],
  [
    "run-control-result",
    {
      schema_version: 1,
      control_id: controlClaim.control_id,
      ...binding,
      runner_id: control.runner_id,
      action: control.action,
      state: "pending",
      disposition: null,
      expires_at: expiry,
    },
  ],
];
const fixtures = [];
function fixture(schema, suffix, value, category) {
  fixtures.push([
    `${category ? "invalid" : "valid"}/${schema}.c09-${suffix}.json`,
    schema,
    value,
    category,
  ]);
}
for (const [schema, value] of documents) {
  fixture(schema, "synthetic", value);
  fixture(schema, "shell", { ...value, command: "synthetic-invalid-shell" }, "shell_data");
  fixture(
    schema,
    "path",
    { ...value, local_path: "/synthetic/not-a-launch-input" },
    "additional_field",
  );
}
for (const action of ["focus_existing", "resume", "terminate", "cancel"])
  fixture("run-control-request", action, { ...control, action });
fixture("launch-specification", "resume", {
  ...specification,
  resume_session: { provider_session_id: id(14), observed_session_id: "synthetic-session-1" },
});
fixture(
  "launch-specification",
  "resume-shell",
  {
    ...specification,
    resume_session: { provider_session_id: id(14), observed_session_id: "synthetic;echo" },
  },
  "type_mismatch",
);
fixture(
  "launch-specification",
  "model-shell",
  { ...specification, execution_config: { ...execution, model: "synthetic;echo" } },
  "type_mismatch",
);
fixture(
  "launch-claim-result",
  "nested-shell",
  {
    ...claimed,
    snapshot: { ...snapshot, execution_config: { ...execution, argv: ["synthetic"] } },
  },
  "shell_data",
);
fixture(
  "launch-tighten-request",
  "instructions",
  { ...tighten, document: { instructions: "synthetic invalid policy" } },
  "additional_field",
);
fixture(
  "launch-start-request",
  "repository-url",
  { ...start, repository_url: "https://synthetic.invalid/repo" },
  "additional_field",
);
fixture("launch-start-request", "branch", { ...start, branch: "synthetic" }, "additional_field");
fixture(
  "launch-start-request",
  "token",
  { ...start, token: "synthetic-invalid-token" },
  "additional_field",
);
fixture(
  "run-control-request",
  "arbitrary-signal",
  { ...control, action: "SIGKILL" },
  "type_mismatch",
);
fixture("checkout-lease-observation", "unknown", {
  ...observation,
  operation: "unknown",
  supervisor_state: "ambiguous",
  descendants_state: "escaped",
});
fixture("checkout-lease-observation", "recover", {
  ...observation,
  operation: "recover",
  supervisor_state: "gone",
  group_state: "gone",
  lock_state: "gone",
  descendants_state: "gone",
  recovery_local: true,
});
fixture("checkout-lease-observation", "release-never-started", {
  ...observation,
  supervisor: undefined,
  operation: "release",
  owned_group_id: 0,
  owned_group_start_identity: "",
  supervisor_state: "never_started",
  group_state: "never_started",
  lock_state: "never_acquired",
  descendants_state: "none",
});
fixture(
  "checkout-lease-observation",
  "process-path",
  { ...observation, supervisor: { ...supervisor, executable: "/synthetic/provider" } },
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
const names = new Set(fixtures.map(([path]) => path));
const ownedEntries = fixtures.map(([path, schema, , category]) => ({
  path,
  schema,
  expect: category ? "reject" : "accept",
  ...(category ? { category } : {}),
}));
if (check)
  assert.deepEqual(
    matrix.fixtures.filter((entry) => names.has(entry.path)),
    ownedEntries,
  );
else
  await output(matrixPath, {
    ...matrix,
    fixtures: [...matrix.fixtures.filter((entry) => !names.has(entry.path)), ...ownedEntries],
  });
console.log(`C09 fixtures ${check ? "checked" : "generated"}: ${fixtures.length}`);

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

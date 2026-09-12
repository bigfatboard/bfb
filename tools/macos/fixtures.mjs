// ABOUTME: Generates synthetic native Local RPC and intent-confusion golden fixtures.
// ABOUTME: Preserves lexical adversarial JSON and verifies owned fixtures without changing other packages' evidence.

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

import prettierConfig from "../../prettier.config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const directory = resolve(root, "protocol/fixtures/v1");
const check = process.argv.includes("--check");
const ulid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const uuid = "e0da52a9-d0cb-47d8-867b-e08f684b9001";
const base = { schema_version: 1, request_id: ulid, method: "app.wake", direction: "request" };
const enrollment = JSON.parse(
  await readFile(resolve(directory, "valid/runner-local-enrollment.pending.json"), "utf8"),
);
const pending = JSON.parse(
  await readFile(resolve(directory, "valid/runner-local-enrollment.key-pending.json"), "utf8"),
);
const fixtures = [];
function add(name, value, category, schema = "local-rpc") {
  fixtures.push({
    path: `${category ? "invalid" : "valid"}/${schema}.l04-${name}.json`,
    schema,
    value,
    category,
  });
}
const wrap = (value) => ({
  ...base,
  direction: "response",
  method: "runner.list",
  payload: { enrollments: [value] },
});
add("wake", { ...base, payload: { wake_intent_id: ulid } });
add("terminal", {
  ...base,
  direction: "response",
  method: "app.poll",
  payload: { app_delivery_id: ulid, app_action: "open_terminal", terminal_intent_id: uuid },
});
add("notification", {
  ...base,
  direction: "response",
  method: "app.poll",
  payload: { app_delivery_id: ulid, app_action: "notify_attention", notification_id: ulid },
});
add("locked", { ...base, method: "app.poll", payload: { app_session_state: "locked" } });
add("complete", {
  ...base,
  method: "app.complete",
  payload: { app_delivery_id: ulid, app_result: "consent_denied" },
});
add("enrollment", wrap(enrollment));
add("pending-key", wrap(pending));
add("unicode-scalars", wrap({ ...enrollment, device_label: "😀".repeat(40) }));
add("unknown-version", { ...base, schema_version: 2 }, "unknown_version");
add("cloud-as-terminal", { ...base, payload: { terminal_intent_id: ulid } }, "bound_exceeded");
add("terminal-as-cloud", { ...base, payload: { wake_intent_id: uuid } }, "bound_exceeded");
add(
  "uppercase-uuid",
  { ...base, payload: { terminal_intent_id: uuid.toUpperCase() } },
  "type_mismatch",
);
add(
  "uuid-version",
  { ...base, payload: { terminal_intent_id: uuid.replace("-47d8-", "-17d8-") } },
  "type_mismatch",
);
add(
  "nested-extra",
  wrap({ ...enrollment, local_path: "/synthetic/not-permitted" }),
  "additional_field",
);
add(
  "missing-key",
  wrap(Object.fromEntries(Object.entries(pending).filter(([key]) => key !== "public_key"))),
  "missing_field",
);
add("null-active-key", wrap({ ...enrollment, public_key: null }), "type_mismatch");
add("calendar-date", wrap({ ...enrollment, created_at: "2026-02-30T12:00:00Z" }), "type_mismatch");
add(
  "timestamp-precision",
  wrap({ ...enrollment, created_at: "2026-09-12T12:00:00.1234567Z" }),
  "type_mismatch",
);
add(
  "timestamp-offset",
  wrap({ ...enrollment, created_at: "2026-09-12T12:00:00+00:00" }),
  "type_mismatch",
);
add("unicode-bound", wrap({ ...enrollment, device_label: "😀".repeat(81) }), "bound_exceeded");
add(
  "duplicate-key",
  JSON.stringify(base).replace('"schema_version":1', '"schema_version":1,"\\u0073chema_version":1'),
  "schema_invalid",
);
add(
  "fractional-version",
  JSON.stringify(base).replace('"schema_version":1', '"schema_version":1.0000000000000000000001'),
  "type_mismatch",
);
add(
  "exponent-version",
  JSON.stringify(base).replace('"schema_version":1', '"schema_version":1e999999999'),
  "unknown_version",
);
add(
  "lone-surrogate",
  JSON.stringify(base).replace('"method":"app.wake"', '"method":"\\ud800"'),
  "schema_invalid",
);
add(
  "exact-integer",
  JSON.stringify(base).replace('"schema_version":1', '"schema_version":1e0000000000000000'),
);
add(
  "long-integer",
  JSON.stringify(base).replace('"schema_version":1', '"schema_version":1.' + "0".repeat(400)),
);

async function output(path, value) {
  const text =
    typeof value === "string"
      ? value + "\n"
      : await format(JSON.stringify(value), { ...prettierConfig, parser: "json" });
  if (check) assert.equal(await readFile(path, "utf8"), text, "native fixture drift: " + path);
  else await writeFile(path, text);
}
for (const fixture of fixtures) await output(resolve(directory, fixture.path), fixture.value);
const matrixPath = resolve(directory, "matrix.json");
const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
const names = new Set(fixtures.map((fixture) => fixture.path));
const entries = fixtures.map(({ path, schema, category }) => ({
  path,
  schema,
  expect: category ? "reject" : "accept",
  ...(category ? { category } : {}),
}));
if (check)
  assert.deepEqual(
    matrix.fixtures.filter((entry) => names.has(entry.path)),
    entries,
  );
else
  await output(matrixPath, {
    ...matrix,
    fixtures: [...matrix.fixtures.filter((entry) => !names.has(entry.path)), ...entries],
  });
console.log("Native Local RPC fixture drift: passed (" + entries.length + " fixtures)");

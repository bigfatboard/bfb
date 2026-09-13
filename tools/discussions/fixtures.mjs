// ABOUTME: Generates bounded synthetic D01 discussion documents and adversarial wire fixtures.
// ABOUTME: Check mode verifies deterministic TypeScript and Go fixture-matrix ownership without writes.

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import prettierConfig from "../../prettier.config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const check = process.argv.includes("--check");
const id = (number) => `01K0000000000000000000${String(number).padStart(4, "0")}`;
const digest = `sha256:${"a".repeat(64)}`,
  revision = "a".repeat(40),
  now = "2026-09-12T12:00:00.000Z";
const create = {
  schema_version: 1,
  idempotency_key: "d01-synthetic-create",
  task_id: id(1),
  expected_task_version: 1,
  question: "Synthetic comparison: preserve explicit human decisions.",
  git_revision: revision,
  workspace_policy_version: 2,
  project_policy_version: 2,
  repository_config_version: 2,
  participants: [2, 3].map((n) => ({
    agent_profile_id: id(n),
    agent_profile_version: 1,
    runner_id: id(4),
    checkout_id: id(5),
  })),
};
const change = {
  schema_version: 1,
  idempotency_key: "d01-synthetic-change",
  discussion_id: id(6),
  expected_version: 1,
  action: "intervene",
  text: "Synthetic human clarification.",
};
const decision = {
  kind: "needs_more_context",
  summary: "Synthetic unresolved tradeoff.",
  recommendation_ids: [id(20), id(21)],
};
const output = {
  schema_version: 1,
  recommendation: "Synthetic recommendation, not work acceptance.",
  reasons: ["Synthetic bounded rationale."],
  evidence: [
    { kind: "context", context_id: id(7), explanation: "Synthetic brief constraint." },
    {
      kind: "repository",
      repository_path: "src/synthetic.ts",
      git_revision: revision,
      line: 4,
      explanation: "Synthetic revision-bound evidence.",
    },
  ],
  agreement: [{ message_id: id(20), reason: "Synthetic shared premise." }],
  disagreements: [{ message_id: id(21), reason: "Synthetic unresolved tradeoff." }],
  human_questions: ["Which synthetic tradeoff is acceptable?"],
};
const turn = {
  schema_version: 1,
  idempotency_key: "d01-synthetic-turn",
  discussion_id: id(6),
  expected_version: 3,
  turn_id: id(8),
  expected_turn_version: 1,
  action: "accept",
};
const delivered = { ...turn, delivery_id: id(9), expected_delivery_version: 1 };
const receipt = {
  schema_version: 1,
  discussion_id: id(6),
  version: 1,
  state: "active",
  run_ids: [id(10), id(11)],
  brief_hash: digest,
};
const message = {
  id: id(20),
  kind: "recommendation",
  created_at: now,
  participant_id: id(12),
  run_id: id(10),
  session_id: id(14),
  turn_id: id(8),
  output,
};
const view = {
  schema_version: 1,
  scope: "human",
  discussion_id: id(6),
  task_id: id(1),
  state: "concluded",
  version: 25,
  deadline: now,
  brief_hash: digest,
  brief: {
    schema_version: 1,
    task_id: id(1),
    title: "Synthetic issue",
    question: create.question,
    git_revision: revision,
    context: [
      {
        id: id(7),
        kind: "constraint",
        body: "Synthetic read-only boundary.",
        version: 1,
        audience: "agent",
        content_hash: digest,
        created_at: now,
      },
    ],
  },
  participants: ["claude", "codex"].map((provider, slot) => ({
    id: id(12 + slot),
    run_id: id(10 + slot),
    agent_profile_id: id(2 + slot),
    name: `Synthetic ${provider}`,
    provider,
    runner_id: id(4),
    checkout_id: id(5),
  })),
  turns: [
    {
      id: id(8),
      participant_id: id(12),
      ordinal: 1,
      state: "completed",
      version: 3,
      delivery: {
        id: id(9),
        state: "completed",
        version: 4,
        session_id: id(14),
        source_message_ids: [],
      },
    },
  ],
  messages: [
    {
      id: id(22),
      kind: "intervention",
      created_at: now,
      author_human_id: id(15),
      text: change.text,
    },
    message,
  ],
  conclusion: { recommendation_ids: [id(20), id(21)], created_at: now },
  decision: { id: id(16), human_id: id(15), created_at: now, ...decision },
};
const fixtures = [];
function fixture(schema, suffix, value, category) {
  fixtures.push([
    `${category ? "invalid" : "valid"}/${schema}.d01-${suffix}.json`,
    schema,
    value,
    category,
  ]);
}
const without = (value, ...keys) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
for (const [schema, value] of [
  ["discussion-create-request", create],
  ["discussion-change-request", change],
  ["discussion-recommendation", output],
  ["discussion-turn-request", turn],
  ["discussion-receipt", receipt],
  ["discussion-view", view],
]) {
  fixture(schema, "synthetic", value);
  fixture(schema, "unknown-field", { ...value, synthetic_unknown: true }, "additional_field");
  fixture(schema, "future-version", { ...value, schema_version: 2 }, "unknown_version");
}
fixture("discussion-create-request", "bounded-options", {
  ...create,
  rounds: 1,
  duration_seconds: 60,
  git_revision: "b".repeat(64),
});
fixture(
  "discussion-create-request",
  "three-participants",
  { ...create, participants: [...create.participants, create.participants[0]] },
  "bound_exceeded",
);
fixture("discussion-create-request", "too-many-rounds", { ...create, rounds: 4 }, "bound_exceeded");
fixture(
  "discussion-create-request",
  "unbounded-duration",
  { ...create, duration_seconds: 3601 },
  "bound_exceeded",
);
fixture(
  "discussion-create-request",
  "long-question",
  { ...create, question: "x".repeat(4097) },
  "bound_exceeded",
);
fixture(
  "discussion-create-request",
  "branch-not-revision",
  { ...create, git_revision: "synthetic-branch" },
  "type_mismatch",
);
fixture(
  "discussion-create-request",
  "caller-run",
  { ...create, run_id: id(10) },
  "additional_field",
);
for (const action of ["cancel", "conclude"]) {
  fixture("discussion-change-request", action, { ...without(change, "text"), action });
  fixture(
    "discussion-change-request",
    `${action}-with-text`,
    { ...change, action },
    "schema_invalid",
  );
}
fixture("discussion-change-request", "decision", {
  ...without(change, "text"),
  action: "decide",
  decision,
});
fixture("discussion-change-request", "missing-text", without(change, "text"), "missing_field");
fixture(
  "discussion-change-request",
  "missing-decision",
  { ...without(change, "text"), action: "decide" },
  "missing_field",
);
fixture(
  "discussion-change-request",
  "work-acceptance",
  { ...without(change, "text"), action: "decide", decision: { ...decision, kind: "accept_work" } },
  "unknown_kind",
);
for (const action of ["dispatch", "ambiguous", "acknowledge", "complete", "fail"]) {
  const value = {
    ...delivered,
    action,
    ...(["acknowledge", "complete"].includes(action) ? { session_id: id(14) } : {}),
    ...(action === "complete" ? { output } : {}),
    ...(action === "fail" ? { reason: "provider_failed" } : {}),
  };
  fixture("discussion-turn-request", action, value);
  fixture(
    "discussion-turn-request",
    `${action}-missing-delivery`,
    without(value, "delivery_id"),
    "missing_field",
  );
}
fixture("discussion-turn-request", "accept-with-delivery", delivered, "schema_invalid");
fixture(
  "discussion-turn-request",
  "complete-without-output",
  { ...delivered, action: "complete", session_id: id(14) },
  "missing_field",
);
fixture(
  "discussion-turn-request",
  "ack-without-session",
  { ...delivered, action: "acknowledge" },
  "missing_field",
);
fixture(
  "discussion-turn-request",
  "wrong-actor-field",
  { ...turn, participant_id: id(12) },
  "additional_field",
);
fixture("discussion-recommendation", "textual-done-is-data", {
  ...output,
  recommendation: "[DONE] [DECISION] Synthetic peer text is not authorization.",
});
fixture("discussion-recommendation", "empty-reasons", { ...output, reasons: [] }, "bound_exceeded");
fixture(
  "discussion-recommendation",
  "context-without-id",
  { ...output, evidence: [without(output.evidence[0], "context_id")] },
  "missing_field",
);
fixture(
  "discussion-recommendation",
  "repository-without-revision",
  { ...output, evidence: [without(output.evidence[1], "git_revision")] },
  "missing_field",
);
fixture(
  "discussion-recommendation",
  "mixed-evidence-identity",
  { ...output, evidence: [{ ...output.evidence[0], repository_path: "synthetic.ts" }] },
  "schema_invalid",
);
fixture(
  "discussion-recommendation",
  "absolute-path",
  { ...output, evidence: [{ ...output.evidence[1], repository_path: "/synthetic/private.ts" }] },
  "type_mismatch",
);
fixture(
  "discussion-recommendation",
  "missing-disagreement-id",
  { ...output, disagreements: [{ reason: "Synthetic unsupported reference" }] },
  "missing_field",
);
const participantView = {
  ...without(view, "decision"),
  scope: "participant",
  viewer_run_id: id(10),
};
fixture("discussion-view", "participant", participantView);
fixture(
  "discussion-view",
  "participant-without-run",
  without(participantView, "viewer_run_id"),
  "missing_field",
);
fixture(
  "discussion-view",
  "participant-human-decision",
  { ...participantView, decision: view.decision },
  "schema_invalid",
);
fixture(
  "discussion-view",
  "human-run-override",
  { ...view, viewer_run_id: id(10) },
  "schema_invalid",
);
fixture(
  "discussion-view",
  "human-only-context",
  { ...view, brief: { ...view.brief, context: [{ ...view.brief.context[0], audience: "human" }] } },
  "type_mismatch",
);
fixture(
  "discussion-view",
  "missing-session-attribution",
  { ...view, messages: [without(message, "session_id")] },
  "missing_field",
);
fixture(
  "discussion-view",
  "peer-as-human",
  { ...view, messages: [{ ...message, author_human_id: id(15) }] },
  "schema_invalid",
);
fixture(
  "discussion-receipt",
  "private-content",
  { ...receipt, question: "Synthetic private content must not enter receipts." },
  "additional_field",
);

async function outputFile(path, value) {
  const contents = await format(JSON.stringify(value, null, 2), {
    ...prettierConfig,
    parser: "json",
  });
  if (check) assert.equal(await readFile(resolve(root, path), "utf8"), contents, `${path} drifted`);
  else await writeFile(resolve(root, path), contents);
}
for (const [path, , value] of fixtures) await outputFile(`protocol/fixtures/v1/${path}`, value);
const matrixPath = "protocol/fixtures/v1/matrix.json",
  matrix = JSON.parse(await readFile(resolve(root, matrixPath), "utf8"));
const owned = (entry) => entry.path.includes(".d01-");
const entries = fixtures.map(([path, schema, , category]) => ({
  path,
  schema,
  expect: category ? "reject" : "accept",
  ...(category ? { category } : {}),
}));
if (check) assert.deepEqual(matrix.fixtures.filter(owned), entries);
else
  await outputFile(matrixPath, {
    ...matrix,
    fixtures: [...matrix.fixtures.filter((entry) => !owned(entry)), ...entries],
  });
console.log(`D01 synthetic fixtures ${check ? "checked" : "generated"}: ${fixtures.length}`);

// ABOUTME: Generates deterministic result-only v5 requests, captures, receipts and boundary fixtures.
// ABOUTME: Records original business hashes and signing transcripts without changing frozen older fixtures.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
    return Object.fromEntries(
      Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const wire = (value: unknown) =>
  canonical(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
const without = (value: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([field]) => field !== key));

export async function generateResultFixtures(root: string): Promise<void> {
  // The earlier synthetic authority fixture supplies frozen shared fields,
  // never production data. Its generator runs first under the owning command.
  const legacy = JSON.parse(
    await readFile(path.join(root, "protocol/fixtures/v3/local-agent-work-rpc.json"), "utf8"),
  ) as {
    fixtures: Array<{ document: string; accept: boolean; json: string }>;
  };
  const authority = JSON.parse(
    legacy.fixtures.find((f) => f.document === "agent-capture-confirmation-result" && f.accept)!
      .json,
  ) as Record<string, unknown>;
  const id = "01K6R7DT00AAAAAAAAAAAAAAAA";
  const reference = {
    schema_version: 1,
    run_execution_id: id,
    assignment_generation: 1,
    request_id: "result-fixture-001",
  };
  const permission = { allow_submit_result: true, max_pending_age_seconds: 300 };
  const deny = { allow_submit_result: false, max_pending_age_seconds: 0 };
  const confirmation = { ...authority, configured_permission: permission, can_submit: true };
  const request = {
    reference,
    binding: authority.binding,
    summary: "  Synthetic <>& \u2028 \u2029 \\u2028  ",
    limitations: "",
    evidence_refs: [{ kind: "artifact", ref: "synthetic-ref", version: "v1" }],
    git_dirty: false,
  };
  const local = {
    correlation: "synthetic-private-correlation",
    request: without(request, "binding"),
  };
  const operationKey = "agent:" + hash(canonical({ tool: "submit_result", ...reference }));
  const capture = {
    schema_version: 1,
    confirmation,
    operation: {
      command_name: "result.submit",
      tool: "bfb_submit_result",
      operation_schema_version: 1,
      operation_key: operationKey,
      request_id: reference.request_id,
      payload_hash: "sha256:" + hash(canonical(request)),
      expected_version: null,
      target_task_id: id,
      parent_task_id: null,
    },
    admission_mode: "offline_admitted",
    admitted_permission: permission,
    captured_at: "2026-10-06T12:00:00.001Z",
    intent_expires_at: "2026-10-06T12:05:00.000Z",
    signature: Buffer.alloc(64).toString("base64url"),
  };
  const online = {
    ...capture,
    admission_mode: "online_only",
    admitted_permission: deny,
    intent_expires_at: null,
  };
  const result = {
    submission_id: id,
    version: 1,
    result_state: "submitted",
    task_state: "review",
    run_version: 2,
    task_version: 2,
    origin: {
      run_id: id,
      run_execution_id: id,
      assignment_generation: 1,
      provider_session_id: (authority.binding as Record<string, unknown>).provider_session_id,
    },
  };
  const receipt = {
    schema_version: 1,
    operation_key: operationKey,
    request_id: reference.request_id,
    tool: "bfb_submit_result",
    admission_mode: "offline_admitted",
    delivery_state: "pending_sync",
    effect_certainty: "not_attempted",
    captured_at: capture.captured_at,
    intent_expires_at: capture.intent_expires_at,
    reason_code: null,
  };
  const envelope = (direction: string, payload: unknown) => ({
    schema_version: 5,
    request_id: id,
    method: "mcp.v5.submit_result",
    direction,
    payload,
  });
  const fixtures: Array<{
    name: string;
    document: string;
    json: string;
    accept: boolean;
    canonical_sha256?: string;
    business_json?: string;
    business_sha256?: string;
    transcript_sha256?: string;
  }> = [];
  const add = (name: string, document: string, value: unknown, accept: boolean, extra = {}) => {
    const json = typeof value === "string" ? value : JSON.stringify(value);
    fixtures.push({
      name,
      document,
      json,
      accept,
      ...(accept ? { canonical_sha256: hash(wire(JSON.parse(json))) } : {}),
      ...extra,
    });
  };
  add("request.original", "agent-result-request", request, true, {
    business_json: canonical(request),
    business_sha256: hash(canonical(request)),
  });
  add(
    "request.absent-options",
    "agent-result-request",
    { reference, binding: request.binding, summary: "Synthetic summary" },
    true,
  );
  const emptyRefs = {
    reference,
    binding: request.binding,
    summary: "Synthetic summary",
    evidence_refs: [],
  };
  add("request.explicit-empty-evidence", "agent-result-request", emptyRefs, true, {
    business_json: canonical(emptyRefs),
    business_sha256: hash(canonical(emptyRefs)),
  });
  add(
    "request.maximum-fields",
    "agent-result-request",
    { ...request, summary: "😀".repeat(2048), limitations: "😀".repeat(2048) },
    true,
  );
  for (const [name, changed] of Object.entries({
    "empty-summary": { ...request, summary: "" },
    "long-summary": { ...request, summary: "x".repeat(2049) },
    "null-limitations": { ...request, limitations: null },
    "long-limitations": { ...request, limitations: "x".repeat(2049) },
    "missing-binding": without(request, "binding"),
    "client-capture": { ...request, capture },
    "unknown-evidence": {
      ...request,
      evidence_refs: [{ kind: "artifact", ref: "synthetic", command: "forbidden" }],
    },
    "too-many-evidence": {
      ...request,
      evidence_refs: Array(21).fill({ kind: "artifact", ref: "synthetic" }),
    },
    "null-evidence": { ...request, evidence_refs: null },
    "bad-kind": { ...request, evidence_refs: [{ kind: "Artifact", ref: "synthetic" }] },
    "bad-hash": {
      ...request,
      evidence_refs: [{ kind: "artifact", ref: "synthetic", hash: "bad" }],
    },
    "bad-commit": { ...request, git_commit: "A".repeat(40) },
    "wrong-dirty": { ...request, git_dirty: "true" },
    "zero-generation": { ...request, reference: { ...reference, assignment_generation: 0 } },
  }))
    add("request." + name, "agent-result-request", changed, false);
  add(
    "request.utf8-byte-overflow",
    "agent-result-request",
    { ...request, evidence_refs: Array(20).fill({ kind: "artifact", ref: "😀".repeat(512) }) },
    false,
  );
  add("local.cli", "agent-result-local-request", local, true);
  add(
    "local.activated",
    "agent-result-local-request",
    { ...local, expected_binding: request.binding },
    true,
  );
  add(
    "local.null-assertion",
    "agent-result-local-request",
    { ...local, expected_binding: null },
    false,
  );
  add("local.binding-in-body", "agent-result-local-request", { ...local, request }, false);
  add("local.client-confirmation", "agent-result-local-request", { ...local, confirmation }, false);
  add("result.committed", "agent-result-result", result, true);
  add(
    "result.alias-version",
    "agent-result-result",
    { ...without(result, "version"), submission_version: 1 },
    false,
  );
  add("result.review-not-done", "agent-result-result", { ...result, task_state: "done" }, false);
  add(
    "confirmation.request",
    "agent-result-confirmation-request",
    {
      schema_version: 1,
      request_id: id,
      run_execution_id: id,
      assignment_generation: 1,
      binding: request.binding,
    },
    true,
  );
  add("confirmation.live", "agent-result-confirmation-result", confirmation, true);
  add(
    "confirmation.submitted-retry",
    "agent-result-confirmation-result",
    { ...confirmation, can_submit: false },
    true,
  );
  add(
    "confirmation.deny",
    "agent-result-confirmation-result",
    { ...confirmation, configured_permission: deny },
    true,
  );
  for (const [name, changed] of Object.entries({
    "work-permission": { ...confirmation, configured_permission: authority.configured_permission },
    "missing-can-submit": without(confirmation, "can_submit"),
    "missing-epoch": without(confirmation, "runner_grant_epoch"),
    "true-zero": {
      ...confirmation,
      configured_permission: { ...permission, max_pending_age_seconds: 0 },
    },
    "false-nonzero": {
      ...confirmation,
      configured_permission: { ...deny, max_pending_age_seconds: 1 },
    },
    "over-age": {
      ...confirmation,
      configured_permission: { ...permission, max_pending_age_seconds: 301 },
    },
  }))
    add("confirmation." + name, "agent-result-confirmation-result", changed, false);
  add("capture.offline", "agent-result-capture", capture, true, {
    transcript_sha256: hash(
      "BFB-AGENT-RESULT-CAPTURE-V1\n" + canonical(without(capture, "signature")) + "\n",
    ),
  });
  add("capture.online", "agent-result-capture", online, true);
  for (const [name, changed] of Object.entries({
    "cannot-create": { ...capture, confirmation: { ...confirmation, can_submit: false } },
    "wrong-command": {
      ...capture,
      operation: { ...capture.operation, command_name: "agent_run.comment" },
    },
    "wrong-tool": { ...capture, operation: { ...capture.operation, tool: "bfb_add_comment" } },
    "expected-version": { ...capture, operation: { ...capture.operation, expected_version: 1 } },
    parent: { ...capture, operation: { ...capture.operation, parent_task_id: id } },
    "no-source-target": { ...capture, operation: { ...capture.operation, target_task_id: null } },
    "online-expiry": { ...online, intent_expires_at: capture.intent_expires_at },
    "offline-null-expiry": { ...capture, intent_expires_at: null },
    "bad-signature": { ...capture, signature: "not-a-signature" },
    "work-permission": { ...capture, admitted_permission: authority.configured_permission },
  }))
    add("capture." + name, "agent-result-capture", changed, false);
  const replay = {
    schema_version: 1,
    command_name: "result.submit",
    original_request: request,
    capture,
  };
  add("replay.original", "agent-result-replay-request", replay, true);
  add(
    "replay.online-forbidden",
    "agent-result-replay-request",
    { ...replay, capture: online },
    false,
  );
  add("receipt.pending", "agent-result-receipt", receipt, true);
  add(
    "receipt.applied",
    "agent-result-receipt",
    { ...receipt, delivery_state: "applied", effect_certainty: "confirmed" },
    true,
  );
  add(
    "receipt.invalid-transition",
    "agent-result-receipt",
    { ...receipt, delivery_state: "rejected", reason_code: "invalid_transition" },
    true,
  );
  add(
    "receipt.unavailable",
    "agent-result-receipt",
    {
      ...receipt,
      delivery_state: "delivery_blocked",
      effect_certainty: "possibly_applied",
      reason_code: "work_unavailable",
    },
    true,
  );
  add(
    "receipt.uncertain-applied",
    "agent-result-receipt",
    { ...receipt, delivery_state: "applied" },
    false,
  );
  add(
    "receipt.unknown-reason",
    "agent-result-receipt",
    { ...receipt, delivery_state: "delivery_blocked", reason_code: "outcome_unknown" },
    false,
  );
  add(
    "v5.request",
    "local-agent-result-rpc",
    envelope("request", { agent_result_request: local }),
    true,
  );
  add("v5.result", "local-agent-result-rpc", envelope("response", { agent_result: result }), true);
  add(
    "v5.receipt",
    "local-agent-result-rpc",
    envelope("response", { agent_result_receipt: receipt }),
    true,
  );
  add(
    "v5.error",
    "local-agent-result-rpc",
    {
      ...without(envelope("response", {}), "payload"),
      error: {
        schema_version: 1,
        category: "authorization_denied",
        code: "forbidden",
        message: "Result unavailable",
      },
    },
    true,
  );
  for (const version of [1, 2, 3, 4, 6])
    add(
      "v5.version." + version,
      "local-agent-result-rpc",
      { ...envelope("request", { agent_result_request: local }), schema_version: version },
      false,
    );
  for (const method of ["mcp.v3.submit_result", "mcp.v5.replay", "mcp.v5.add_comment"])
    add(
      "v5.method." + method,
      "local-agent-result-rpc",
      { ...envelope("request", { agent_result_request: local }), method },
      false,
    );
  for (const document of [
    "local-rpc",
    "local-agent-rpc",
    "local-agent-work-rpc",
    "local-agent-attention-rpc",
  ])
    add(
      "v5.forbidden-in." + document,
      document,
      envelope("request", { agent_result_request: local }),
      false,
    );
  add(
    "v5.mixed-payload",
    "local-agent-result-rpc",
    envelope("response", { agent_result: result, agent_result_receipt: receipt }),
    false,
  );
  add(
    "v5.duplicate-key",
    "local-agent-result-rpc",
    JSON.stringify(envelope("request", { agent_result_request: local })).replace(
      '"schema_version":5',
      '"schema_version":5,"schema_version":5',
    ),
    false,
  );
  await mkdir(path.join(root, "protocol/fixtures/v5"), { recursive: true });
  await writeFile(
    path.join(root, "protocol/fixtures/v5/local-agent-result-rpc.json"),
    JSON.stringify(
      {
        document: "local-agent-result-rpc",
        schema_version: 5,
        owner_command: "pnpm protocol:generate",
        fixtures,
      },
      null,
      2,
    ) + "\n",
  );
}

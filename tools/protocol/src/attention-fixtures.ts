// ABOUTME: Generates deterministic closed v4 attention fixtures for both production wire codecs.
// ABOUTME: Covers online-only method isolation, nullable metadata, original provenance and bounded inputs.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
    return Object.fromEntries(
      Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  })
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export async function generateAttentionFixtures(root: string): Promise<void> {
  const reference = {
    schema_version: 1,
    run_execution_id: "01K6R7DT00AAAAAAAAAAAAAAAA",
    assignment_generation: 7,
    request_id: "attention-fixture-001",
  };
  const binding = {
    provider_session_id: "01K6R7DT00BBBBBBBBBBBBBBBB",
    provider: "codex",
    observed_session_id: "synthetic-attention-session",
  };
  const request = {
    reference,
    binding,
    kind: "clarification",
    question: "Synthetic attention question",
    blocking: true,
  };
  const read = { reference, attention_id: "01K6R7DT00CCCCCCCCCCCCCCCC" };
  const attention = {
    id: read.attention_id,
    kind: "clarification",
    required_role: "reviewer",
    question: request.question,
    blocking: true,
    state: "open",
    answer: null,
    resource_version: 1,
    requested_at: "2026-10-06T00:00:00.000Z",
    first_response_at: null,
    answered_at: null,
    resolved_at: null,
  };
  const origin = {
    run_id: "01K6R7DT00DDDDDDDDDDDDDDDD",
    run_execution_id: reference.run_execution_id,
    assignment_generation: reference.assignment_generation,
  };
  const result = { attention, origin, authority_binding: binding };
  const localRequest = { correlation: "synthetic-private-correlation", request };
  const localRead = { correlation: localRequest.correlation, request: read };
  const envelope = (method: string, direction: string, payload: unknown) => ({
    schema_version: 4,
    request_id: "01K6R7DT00EEEEEEEEEEEEEEEE",
    method,
    direction,
    payload,
  });
  const create = envelope("mcp.v4.request_human", "request", {
    agent_attention_request: localRequest,
  });
  const get = envelope("mcp.v4.get_attention", "request", {
    agent_attention_read_request: localRead,
  });
  const fixtures: Array<{
    name: string;
    document: string;
    json: string;
    accept: boolean;
    canonical_sha256?: string;
  }> = [];
  const add = (name: string, document: string, value: unknown, accept: boolean) => {
    const json = typeof value === "string" ? value : JSON.stringify(value);
    fixtures.push({
      name,
      document,
      json,
      accept,
      ...(accept
        ? {
            canonical_sha256: createHash("sha256")
              .update(canonical(JSON.parse(json)))
              .digest("hex"),
          }
        : {}),
    });
  };
  const without = (value: Record<string, unknown>, key: string) =>
    Object.fromEntries(Object.entries(value).filter(([field]) => field !== key));
  add("request.basic", "agent-attention-request", request, true);
  add(
    "request.references",
    "agent-attention-request",
    { ...request, reference_kind: "artifact_version", reference_id: "synthetic-version" },
    true,
  );
  add(
    "request.scalar-bound",
    "agent-attention-request",
    { ...request, question: "😀".repeat(2048) },
    true,
  );
  add(
    "request.too-long",
    "agent-attention-request",
    { ...request, question: "😀".repeat(2049) },
    false,
  );
  for (const [kind, required_role] of [
    ["clarification", "reviewer"],
    ["review", "reviewer"],
    ["blocker", "member"],
    ["credential", "owner"],
    ["capability", "owner"],
    ["destructive_action", "owner"],
  ]) {
    add("request.kind." + kind, "agent-attention-request", { ...request, kind }, true);
    add(
      "record.role." + kind,
      "agent-attention-record",
      { ...attention, kind, required_role },
      true,
    );
    add(
      "record.wrong-role." + kind,
      "agent-attention-record",
      { ...attention, kind, required_role: required_role === "owner" ? "reviewer" : "owner" },
      false,
    );
  }
  for (const [name, changed] of Object.entries({
    "missing-binding": without(request, "binding"),
    "null-binding": { ...request, binding: null },
    "unknown-kind": { ...request, kind: "native_permission" },
    "empty-question": { ...request, question: "" },
    "wrong-blocking": { ...request, blocking: "yes" },
    "unknown-field": { ...request, run_id: origin.run_id },
    "half-reference-kind": { ...request, reference_kind: "artifact_version" },
    "half-reference-id": { ...request, reference_id: "synthetic" },
    "null-reference": { ...request, reference_kind: null, reference_id: null },
    "long-reference-kind": {
      ...request,
      reference_kind: "x".repeat(65),
      reference_id: "synthetic",
    },
    "unsafe-generation": {
      ...request,
      reference: { ...reference, assignment_generation: 9007199254740992 },
    },
    "zero-generation": { ...request, reference: { ...reference, assignment_generation: 0 } },
    "extra-reference": { ...request, reference: { ...reference, workspace_id: origin.run_id } },
  }))
    add("request." + name, "agent-attention-request", changed, false);
  add("read.provisional", "agent-attention-read-request", read, true);
  add("read.activated", "agent-attention-read-request", { ...read, binding }, true);
  add("read.null-binding", "agent-attention-read-request", { ...read, binding: null }, false);
  add(
    "read.foreign-shape",
    "agent-attention-read-request",
    { ...read, run_id: origin.run_id },
    false,
  );
  add(
    "read.invalid-id",
    "agent-attention-read-request",
    { ...read, attention_id: "attention-001" },
    false,
  );
  const answered = {
    ...attention,
    state: "answered",
    answer: "Synthetic committed answer",
    resource_version: 2,
    first_response_at: "2026-10-06T00:00:01.000Z",
    answered_at: "2026-10-06T00:00:01.000Z",
  };
  const resolved = {
    ...answered,
    state: "resolved",
    resource_version: 3,
    resolved_at: "2026-10-06T00:00:02.000Z",
  };
  add("result.open", "agent-attention-result", result, true);
  add("result.provisional", "agent-attention-result", { ...result, authority_binding: null }, true);
  add("result.answered", "agent-attention-result", { ...result, attention: answered }, true);
  add("result.resolved", "agent-attention-result", { ...result, attention: resolved }, true);
  add(
    "result.historical-origin",
    "agent-attention-result",
    {
      ...result,
      origin: {
        ...origin,
        run_execution_id: "01K6R7DT00FFFFFFFFFFFFFFFF",
        assignment_generation: 1,
      },
    },
    true,
  );
  for (const field of ["answer", "first_response_at", "answered_at", "resolved_at"]) {
    add(
      "result.missing." + field,
      "agent-attention-result",
      { ...result, attention: without(attention, field) },
      false,
    );
  }
  add(
    "result.missing-authority",
    "agent-attention-result",
    without(result, "authority_binding"),
    false,
  );
  add(
    "result.open-answer",
    "agent-attention-result",
    { ...result, attention: { ...attention, answer: "not committed" } },
    false,
  );
  add(
    "result.answered-null",
    "agent-attention-result",
    { ...result, attention: { ...answered, answer: null } },
    false,
  );
  add(
    "result.resolved-null",
    "agent-attention-result",
    { ...result, attention: { ...resolved, resolved_at: null } },
    false,
  );
  add("result.unknown-field", "agent-attention-result", { ...result, capture: {} }, false);
  add(
    "result.extra-origin",
    "agent-attention-result",
    { ...result, origin: { ...origin, workspace_id: origin.run_id } },
    false,
  );
  add("local.request", "agent-attention-local-request", localRequest, true);
  add("local.read", "agent-attention-read-local-request", localRead, true);
  for (const [method, input] of [
    ["mcp.v4.request_human", create],
    ["mcp.v4.get_attention", get],
  ] as const) {
    add(method + ".request", "local-agent-attention-rpc", input, true);
    add(
      method + ".response",
      "local-agent-attention-rpc",
      envelope(method, "response", { agent_attention: result }),
      true,
    );
    add(
      method + ".error",
      "local-agent-attention-rpc",
      {
        ...without(input, "payload"),
        direction: "response",
        error: {
          schema_version: 1,
          category: "authorization_denied",
          code: "revoked",
          message: "attention unavailable",
        },
      },
      true,
    );
    for (const version of [1, 2, 3, 5])
      add(
        method + ".version." + version,
        "local-agent-attention-rpc",
        { ...input, schema_version: version },
        false,
      );
    for (const document of ["local-rpc", "local-agent-rpc", "local-agent-work-rpc"])
      add(method + ".forbidden-in." + document, document, input, false);
    add(
      method + ".extra-payload",
      "local-agent-attention-rpc",
      { ...input, payload: { ...(input.payload as object), agent_work_receipt: {} } },
      false,
    );
    add(
      method + ".duplicate-key",
      "local-agent-attention-rpc",
      JSON.stringify(input).replace('"schema_version":4', '"schema_version":4,"schema_version":4'),
      false,
    );
  }
  for (const method of [
    "mcp.v4.wait_for_attention",
    "mcp.v4.replay",
    "mcp.v4.sign",
    "mcp.v3.add_comment",
  ])
    add("method." + method, "local-agent-attention-rpc", { ...create, method }, false);
  add(
    "envelope.wrong-request-field",
    "local-agent-attention-rpc",
    { ...create, payload: get.payload },
    false,
  );
  add(
    "envelope.empty-success",
    "local-agent-attention-rpc",
    envelope("mcp.v4.get_attention", "response", {}),
    false,
  );
  add(
    "envelope.receipt",
    "local-agent-attention-rpc",
    envelope("mcp.v4.request_human", "response", { agent_work_receipt: {} }),
    false,
  );
  for (const [document, value, limit] of [
    ["agent-attention-request", request, 16384],
    ["agent-attention-read-request", read, 16384],
    ["agent-attention-local-request", localRequest, 32768],
    ["agent-attention-read-local-request", localRead, 32768],
    ["agent-attention-result", result, 32768],
    ["local-agent-attention-rpc", create, 65536],
  ] as const) {
    const json = JSON.stringify(value);
    add(
      document + ".exact-raw-byte-limit",
      document,
      json + " ".repeat(limit - Buffer.byteLength(json)),
      true,
    );
    add(
      document + ".excessive-raw-byte-limit",
      document,
      json + " ".repeat(limit + 1 - Buffer.byteLength(json)),
      false,
    );
  }
  const directory = path.join(root, "protocol/fixtures/v4");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "local-agent-attention-rpc.json"),
    JSON.stringify(
      {
        owner_command: "pnpm protocol:generate",
        document: "local-agent-attention-rpc",
        schema_version: 4,
        fixtures,
      },
      null,
      2,
    ) + "\n",
  );
}

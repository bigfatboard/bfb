// ABOUTME: Generates closed capture, replay, receipt and negotiated v3 agent-work fixtures.
// ABOUTME: Records deterministic business digests without changing earlier wire fixture bytes.

import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

interface Fixture {
  name: string;
  document: string;
  json: string;
  accept: boolean;
  canonical_sha256?: string;
  command_name?: string;
  original_request_json?: string;
  business_json?: string;
  business_sha256?: string;
  transcript_sha256?: string;
  error_category?: string;
}

const tools = ["bfb_add_comment", "bfb_propose_task", "bfb_report_progress", "bfb_update_task"];
const commands = [
  ["agent_run.comment", "bfb_add_comment", "add_comment", "agent_comment_request", "agent_comment"],
  ["agent_run.update", "bfb_update_task", "update_task", "agent_update_request", "agent_update"],
  [
    "agent_run.progress",
    "bfb_report_progress",
    "report_progress",
    "agent_progress_request",
    "agent_comment",
  ],
  [
    "agent_run.proposal",
    "bfb_propose_task",
    "propose_task",
    "agent_proposal_request",
    "agent_proposal",
  ],
] as const;
const terminalReasons = [
  "revoked",
  "assignment_ended",
  "capability_closed",
  "session_not_bound",
  "session_conflict",
  "policy_rejected",
  "forbidden",
  "stale_version",
  "child_limit",
  "boundary_escape",
  "request_rejected",
  "invalid_argument",
  "intent_expired",
  "capture_invalid",
  "containment_unknown",
];
const blockedReasons = [
  ...terminalReasons,
  "work_unavailable",
  "legacy_capture_unverifiable",
  "storage_corrupt",
];

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
    return Object.fromEntries(
      Object.entries(nested).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  });
}
function wireCanonical(value: unknown): string {
  return canonical(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export async function generateCaptureFixtures(root: string): Promise<void> {
  const id = "01K6R7DT00AAAAAAAAAAAAAAAA",
    sessionId = "01K6R7DT00BBBBBBBBBBBBBBBB";
  const digest = "sha256:" + "a".repeat(64);
  const binding = {
    provider_session_id: sessionId,
    provider: "fake",
    observed_session_id: "synthetic-session",
  };
  const reference = {
    schema_version: 1,
    run_execution_id: id,
    assignment_generation: 1,
    request_id: "fixture-request-01",
  };
  const bound = { reference, binding };
  const permission = { allowed_tools: tools, max_pending_age_seconds: 300 };
  const confirmation = {
    schema_version: 1,
    confirmation_id: id,
    workspace_id: id,
    project_id: id,
    source_task_id: id,
    run_id: id,
    run_execution_id: id,
    runner_id: id,
    checkout_id: id,
    requesting_human_id: id,
    runner_owner_human_id: id,
    assignment_generation: 1,
    fencing_generation: 1,
    requesting_human_authorization_epoch: 1,
    runner_owner_authorization_epoch: 1,
    runner_authorization_epoch: 1,
    runner_grant_epoch: 1,
    snapshot_generation: 1,
    workspace_policy_version: 1,
    project_policy_version: 1,
    repository_config_version: 1,
    runner_token_epoch: 0,
    physical_worktree_hash: digest,
    runner_key_thumbprint: digest,
    snapshot_hash: digest,
    snapshot_repository_config_hash: digest,
    approved_repository_config_hash: digest,
    binding,
    configured_permission: permission,
    confirmed_at: "2026-10-06T12:00:00.000Z",
    lease_expires_at: "2026-10-06T12:10:00.000Z",
    credential_expires_at: "2026-10-06T12:05:00.000Z",
  };
  const requests: Record<string, Record<string, unknown>> = {
    "agent_run.comment": { ...bound, body: "  Synthetic <>& \u2028 \u2029 \\u2028 \\u2029  " },
    "agent_run.update": {
      ...bound,
      expected_version: 1,
      title: "Synthetic replacement",
      punchline: "Synthetic replacement punchline",
    },
    "agent_run.progress": {
      ...bound,
      summary: "Synthetic checkpoint",
      percent: 12.5,
      confidence: 0.75,
    },
    "agent_run.proposal": { ...bound, title: "Synthetic root proposal" },
  };
  const captureFor = (command: string, request: Record<string, unknown>, offline = true) => {
    const entry = commands.find(([name]) => name === command)!;
    const key =
      "agent:" + hash(canonical({ tool: command.slice("agent_run.".length), ...reference }));
    return {
      schema_version: 1,
      confirmation,
      operation: {
        command_name: command,
        tool: entry[1],
        operation_schema_version: 1,
        operation_key: key,
        request_id: reference.request_id,
        payload_hash: "sha256:" + hash(canonical(request)),
        expected_version: command === "agent_run.update" ? request.expected_version : null,
        target_task_id: command === "agent_run.proposal" ? null : id,
        parent_task_id: request.parent_task_id ?? null,
      },
      admission_mode: offline ? "offline_admitted" : "online_only",
      admitted_permission: offline ? permission : { allowed_tools: [], max_pending_age_seconds: 0 },
      captured_at: "2026-10-06T12:00:00.001Z",
      intent_expires_at: offline ? "2026-10-06T12:05:00.000Z" : null,
      signature: Buffer.alloc(64).toString("base64url"),
    };
  };
  const receiptFor = (
    command: string,
    state: string,
    certainty: string,
    reason: string | null,
    offline = true,
  ) => {
    const capture = captureFor(command, requests[command]!, offline);
    return {
      schema_version: 1,
      operation_key: capture.operation.operation_key,
      request_id: reference.request_id,
      tool: capture.operation.tool,
      admission_mode: capture.admission_mode,
      delivery_state: state,
      effect_certainty: certainty,
      captured_at: capture.captured_at,
      intent_expires_at: capture.intent_expires_at,
      reason_code: reason,
    };
  };
  const fixtures: Fixture[] = [];
  const add = (
    name: string,
    document: string,
    value: unknown,
    accept: boolean,
    extra: Partial<Fixture> = {},
  ) => {
    const json = typeof value === "string" ? value : JSON.stringify(value);
    const fixture: Fixture = { name, document, json, accept, ...extra };
    if (accept) fixture.canonical_sha256 = hash(wireCanonical(JSON.parse(json)));
    fixtures.push(fixture);
  };
  const addBusiness = (
    name: string,
    command: string,
    request: Record<string, unknown>,
    raw = JSON.stringify(request),
  ) => {
    const capture = captureFor(command, request);
    const value = { schema_version: 1, command_name: command, original_request: request, capture };
    const { signature: _signature, ...unsigned } = capture;
    add(
      name,
      "agent-work-replay-request",
      JSON.stringify(value).replace(JSON.stringify(request), raw),
      true,
      {
        command_name: command,
        original_request_json: raw,
        business_json: canonical(request),
        business_sha256: hash(canonical(request)),
        transcript_sha256: hash("BFB-AGENT-WORK-CAPTURE-V1\n" + wireCanonical(unsigned) + "\n"),
      },
    );
  };
  const confirmationRequest = {
    schema_version: 1,
    request_id: id,
    run_execution_id: id,
    assignment_generation: 1,
    binding,
  };
  add("confirmation.request", "agent-capture-confirmation-request", confirmationRequest, true);
  add("confirmation.result", "agent-capture-confirmation-result", confirmation, true);
  add(
    "confirmation.deny",
    "agent-capture-confirmation-result",
    { ...confirmation, configured_permission: { allowed_tools: [], max_pending_age_seconds: 0 } },
    true,
  );
  for (const [field, value] of [
    ["confirmed_at", "0000-01-01T00:00:00.000Z"],
    ["confirmed_at", "2026-02-29T12:00:00.000Z"],
    ["confirmed_at", "2026-10-06T12:00:00Z"],
    ["confirmed_at", "2026-10-06T12:00:00.000+00:00"],
    ["confirmed_at", "2026-10-06T12:00:60.000Z"],
    ["runner_token_epoch", -1],
    ["runner_authorization_epoch", 0],
    ["runner_grant_epoch", 1.5],
    ["physical_worktree_hash", "a".repeat(64)],
  ] as const)
    add(
      "confirmation.invalid." + field + "." + String(value),
      "agent-capture-confirmation-result",
      { ...confirmation, [field]: value },
      false,
    );
  for (const [name, setting] of [
    ["deny-age", { allowed_tools: [], max_pending_age_seconds: 1 }],
    ["allow-zero", { allowed_tools: ["bfb_add_comment"], max_pending_age_seconds: 0 }],
    [
      "duplicate",
      { allowed_tools: ["bfb_add_comment", "bfb_add_comment"], max_pending_age_seconds: 1 },
    ],
    ["unknown", { allowed_tools: ["bfb_get_task"], max_pending_age_seconds: 1 }],
    ["excessive-age", { allowed_tools: tools, max_pending_age_seconds: 301 }],
    ["unknown-setting", { ...permission, allow_all: true }],
  ])
    add(
      "permission." + name,
      "agent-capture-confirmation-result",
      { ...confirmation, configured_permission: setting },
      false,
    );
  for (const [command, tool, method, inputField, resultField] of commands) {
    const request = requests[command]!;
    const capture = captureFor(command, request);
    const { signature: _signature, ...unsigned } = capture;
    add(command + ".capture", "agent-work-capture", capture, true, {
      transcript_sha256: hash("BFB-AGENT-WORK-CAPTURE-V1\n" + wireCanonical(unsigned) + "\n"),
    });
    add(
      command + ".online-capture",
      "agent-work-capture",
      captureFor(command, request, false),
      true,
    );
    addBusiness(command + ".replay", command, request);
    add(
      command + ".wrong-tool",
      "agent-work-capture",
      {
        ...capture,
        operation: {
          ...capture.operation,
          tool: tool === "bfb_add_comment" ? "bfb_update_task" : "bfb_add_comment",
        },
      },
      false,
    );
    add(
      command + ".online-replay",
      "agent-work-replay-request",
      {
        schema_version: 1,
        command_name: command,
        original_request: request,
        capture: captureFor(command, request, false),
      },
      false,
    );
    add(
      command + ".substituted-command",
      "agent-work-replay-request",
      {
        schema_version: 1,
        command_name: command,
        original_request: request,
        capture: {
          ...capture,
          operation: {
            ...capture.operation,
            command_name:
              command === "agent_run.comment" ? "agent_run.update" : "agent_run.comment",
          },
        },
      },
      false,
    );
    const envelope = (direction: string, payload?: unknown) => ({
      schema_version: 3,
      request_id: id,
      method: "mcp.v3." + method,
      direction,
      ...(payload ? { payload } : {}),
    });
    const local = { request, correlation: "synthetic-correlation" };
    add(
      method + ".request",
      "local-agent-work-rpc",
      envelope("request", { [inputField]: local }),
      true,
    );
    const origin = {
      run_id: id,
      run_execution_id: id,
      assignment_generation: 1,
      provider_session_id: sessionId,
    };
    const result =
      resultField === "agent_update"
        ? {
            task: {
              id,
              project_id: id,
              state: "active",
              priority: "P2",
              title: "Synthetic replacement",
              punchline: "",
              resource_version: 2,
            },
            origin,
          }
        : resultField === "agent_proposal"
          ? { id, state: "proposed", origin }
          : { id, origin };
    add(
      method + ".committed",
      "local-agent-work-rpc",
      envelope("response", { [resultField]: result }),
      true,
    );
    add(
      method + ".pending",
      "local-agent-work-rpc",
      envelope("response", {
        agent_work_receipt: receiptFor(command, "pending_sync", "not_attempted", null),
      }),
      true,
    );
    add(
      method + ".uncertain",
      "local-agent-work-rpc",
      envelope("response", {
        agent_work_receipt: receiptFor(
          command,
          "delivery_blocked",
          "possibly_applied",
          "revoked",
          false,
        ),
      }),
      true,
    );
    const error = {
      schema_version: 1,
      category: "authorization_denied",
      code: "revoked",
      message: "Current authority denied.",
    };
    add(method + ".error", "local-agent-work-rpc", { ...envelope("response"), error }, true);
    add(
      method + ".two-results",
      "local-agent-work-rpc",
      envelope("response", {
        [resultField]: result,
        agent_work_receipt: receiptFor(command, "applied", "confirmed", null),
      }),
      false,
    );
    add(
      method + ".error-and-result",
      "local-agent-work-rpc",
      { ...envelope("response", { [resultField]: result }), error },
      false,
    );
    add(
      method + ".wrong-input",
      "local-agent-work-rpc",
      envelope("request", {
        agent_work_receipt: receiptFor(command, "pending_sync", "not_attempted", null),
      }),
      false,
    );
    add(
      method + ".wrong-result",
      "local-agent-work-rpc",
      envelope("response", {
        [resultField === "agent_update" ? "agent_comment" : "agent_update"]: result,
      }),
      false,
    );
    add(
      method + ".v3-as-v2",
      "local-agent-rpc",
      envelope("request", { [inputField]: local }),
      false,
      { error_category: "unknown_version" },
    );
    add(method + ".v3-as-v1", "local-rpc", envelope("request", { [inputField]: local }), false, {
      error_category: "unknown_version",
    });
    add(
      method + ".v2-as-v3",
      "local-agent-work-rpc",
      {
        ...envelope("request", { [inputField]: local }),
        schema_version: 2,
        method: "mcp.v2." + method,
      },
      false,
      { error_category: "unknown_version" },
    );
  }
  addBusiness("proposal.child", "agent_run.proposal", {
    ...requests["agent_run.proposal"]!,
    parent_task_id: id,
    priority: "P0",
  });
  addBusiness("proposal.priority-omitted", "agent_run.proposal", requests["agent_run.proposal"]!);
  addBusiness("proposal.priority-present", "agent_run.proposal", {
    ...requests["agent_run.proposal"]!,
    priority: "P2",
  });
  addBusiness(
    "comment.whitespace",
    "agent_run.comment",
    requests["agent_run.comment"]!,
    JSON.stringify(requests["agent_run.comment"], null, 2),
  );
  addBusiness("comment.literal-backslash", "agent_run.comment", {
    ...bound,
    body: "\\u2028 \\\\u2029",
  });
  addBusiness("update.separators", "agent_run.update", {
    ...bound,
    expected_version: 1,
    title: "<>&\u2028\u2029",
    punchline: "\\u2028",
  });
  addBusiness(
    "progress.exponent",
    "agent_run.progress",
    requests["agent_run.progress"]!,
    JSON.stringify(requests["agent_run.progress"])
      .replace('"percent":12.5', '"percent":125e-1')
      .replace('"confidence":0.75', '"confidence":75e-2'),
  );
  addBusiness(
    "progress.zero",
    "agent_run.progress",
    { ...bound, summary: "Synthetic zero", percent: 0, confidence: 0 },
    JSON.stringify({ ...bound, summary: "Synthetic zero", percent: 0, confidence: 0 }).replace(
      '"percent":0',
      '"percent":-0e9999999999',
    ),
  );
  const progress = requests["agent_run.progress"]!;
  for (const [name, field, source] of [
    ["raw-overflow", "percent", "100.00000000000000001"],
    ["confidence-overflow", "confidence", "1.00000000000000001"],
    ["underflow", "confidence", "1e-324"],
    ["negative", "percent", "-0.01"],
    ["unsafe-reference", "assignment_generation", "9007199254740992"],
    ["fractional-reference", "assignment_generation", "1.00000000000000001"],
  ] as const) {
    const sourceJSON = JSON.stringify({
      schema_version: 1,
      command_name: "agent_run.progress",
      original_request: progress,
      capture: captureFor("agent_run.progress", progress),
    });
    const originalField =
      field === "percent"
        ? '"percent":12.5'
        : field === "confidence"
          ? '"confidence":0.75'
          : '"assignment_generation":1';
    add(
      "progress.replay." + name,
      "agent-work-replay-request",
      sourceJSON.replace(originalField, '"' + field + '":' + source),
      false,
    );
    const envelope = {
      schema_version: 3,
      request_id: id,
      method: "mcp.v3.report_progress",
      direction: "request",
      payload: {
        agent_progress_request: { request: progress, correlation: "synthetic-correlation" },
      },
    };
    add(
      "progress.v3." + name,
      "local-agent-work-rpc",
      JSON.stringify(envelope).replace(originalField, '"' + field + '":' + source),
      false,
    );
  }
  for (const state of ["pending_sync", "applied", "rejected", "delivery_blocked"]) {
    for (const certainty of ["not_attempted", "possibly_applied", "confirmed"]) {
      const valid =
        state === "pending_sync"
          ? certainty !== "confirmed"
          : state === "applied"
            ? certainty === "confirmed"
            : state === "rejected"
              ? certainty === "not_attempted"
              : true;
      add(
        "receipt." + state + "." + certainty,
        "agent-work-receipt",
        receiptFor(
          "agent_run.comment",
          state,
          certainty,
          state === "pending_sync" || state === "applied" ? null : "revoked",
        ),
        valid,
      );
    }
  }
  for (const reason of terminalReasons)
    add(
      "receipt.rejected." + reason,
      "agent-work-receipt",
      receiptFor("agent_run.comment", "rejected", "not_attempted", reason),
      true,
    );
  for (const reason of blockedReasons)
    add(
      "receipt.blocked." + reason,
      "agent-work-receipt",
      receiptFor("agent_run.comment", "delivery_blocked", "possibly_applied", reason),
      true,
    );
  add(
    "receipt.unknown-reason",
    "agent-work-receipt",
    receiptFor("agent_run.comment", "delivery_blocked", "possibly_applied", "arbitrary_reason"),
    false,
  );
  add(
    "receipt.online-pending",
    "agent-work-receipt",
    receiptFor("agent_run.comment", "pending_sync", "not_attempted", null, false),
    false,
  );
  add(
    "receipt.online-applied",
    "agent-work-receipt",
    receiptFor("agent_run.comment", "applied", "confirmed", null, false),
    true,
  );
  add(
    "receipt.online-rejected",
    "agent-work-receipt",
    receiptFor("agent_run.comment", "rejected", "not_attempted", "revoked", false),
    true,
  );
  add(
    "receipt.legacy-false-certainty",
    "agent-work-receipt",
    receiptFor(
      "agent_run.comment",
      "delivery_blocked",
      "not_attempted",
      "legacy_capture_unverifiable",
    ),
    false,
  );
  add(
    "receipt.private-body",
    "agent-work-receipt",
    {
      ...receiptFor("agent_run.comment", "applied", "confirmed", null),
      body: "Synthetic private body",
    },
    false,
  );
  add(
    "receipt.full-capture",
    "agent-work-receipt",
    {
      ...receiptFor("agent_run.comment", "applied", "confirmed", null),
      capture: captureFor("agent_run.comment", requests["agent_run.comment"]!),
    },
    false,
  );
  const capture = captureFor("agent_run.comment", requests["agent_run.comment"]!);
  for (const signature of [
    "A".repeat(85) + "B",
    "A".repeat(86) + "=",
    "A".repeat(85),
    "A".repeat(87),
  ])
    add(
      "capture.signature." + signature.length + "." + signature.at(-1),
      "agent-work-capture",
      { ...capture, signature },
      false,
    );
  add(
    "capture.null-target",
    "agent-work-capture",
    { ...capture, operation: { ...capture.operation, target_task_id: null } },
    false,
  );
  add("capture.caller-key", "agent-work-capture", { ...capture, key_ref: "synthetic-key" }, false);
  add(
    "capture.online-permission",
    "agent-work-capture",
    { ...capture, admission_mode: "online_only", intent_expires_at: null },
    false,
  );
  add(
    "capture.offline-null-expiry",
    "agent-work-capture",
    { ...capture, intent_expires_at: null },
    false,
  );
  add(
    "replay.private-extra",
    "agent-work-replay-request",
    {
      schema_version: 1,
      command_name: "agent_run.comment",
      original_request: requests["agent_run.comment"],
      capture,
      actor_human_id: id,
    },
    false,
  );
  add(
    "capture.duplicate-key",
    "agent-work-capture",
    JSON.stringify(capture).replace('"schema_version":1', '"schema_version":1,"schema_version":1'),
    false,
  );
  const v3 = {
    schema_version: 3,
    request_id: id,
    method: "mcp.v3.add_comment",
    direction: "request",
    payload: {
      agent_comment_request: {
        request: requests["agent_run.comment"],
        correlation: "synthetic-correlation",
      },
    },
  };
  add("v3.undeclared-method", "local-agent-work-rpc", { ...v3, method: "mcp.v3.sign" }, false);
  add("v3.event-direction", "local-agent-work-rpc", { ...v3, direction: "event" }, false);
  add("v3.private-payload", "local-agent-work-rpc", { ...v3, capture }, false);
  const escaped = { ...bound, body: "\u0000".repeat(2048) };
  addBusiness("comment.maximum-escaped", "agent_run.comment", escaped);
  add(
    "v3.maximum-escaped",
    "local-agent-work-rpc",
    {
      ...v3,
      payload: {
        agent_comment_request: { request: escaped, correlation: "synthetic-correlation" },
      },
    },
    true,
  );
  for (const [document, value, limit] of [
    ["agent-capture-confirmation-request", confirmationRequest, 2048],
    ["agent-capture-confirmation-result", confirmation, 4096],
    ["agent-work-capture", capture, 8192],
    [
      "agent-work-replay-request",
      {
        schema_version: 1,
        command_name: "agent_run.comment",
        original_request: requests["agent_run.comment"],
        capture,
      },
      32768,
    ],
    ["agent-work-receipt", receiptFor("agent_run.comment", "applied", "confirmed", null), 2048],
    ["local-agent-work-rpc", v3, 65536],
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
      json + " ".repeat(limit - Buffer.byteLength(json) + 1),
      false,
      { error_category: "bound_exceeded" },
    );
  }
  await mkdir(path.join(root, "protocol/fixtures/v3"), { recursive: true });
  await writeFile(
    path.join(root, "protocol/fixtures/v3/local-agent-work-rpc.json"),
    JSON.stringify(
      {
        owner_command: "pnpm protocol:generate",
        document: "local-agent-work-rpc",
        schema_version: 3,
        fixtures,
      },
      null,
      2,
    ) + "\n",
  );
}

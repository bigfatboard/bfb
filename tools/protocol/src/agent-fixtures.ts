// ABOUTME: Generates deterministic fixtures for the negotiated closed agent RPC document.
// ABOUTME: Covers every fixed v2 action without altering the frozen general v1 fixtures.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function generateAgentFixtures(root: string): Promise<void> {
  const id = "01K6R7DT00AAAAAAAAAAAAAAAA",
    sessionId = "01K6R7DT00BBBBBBBBBBBBBBBB";
  const reference = {
    schema_version: 1,
    run_execution_id: id,
    assignment_generation: 1,
    request_id: "fixture-request-01",
  };
  const binding = {
    provider_session_id: sessionId,
    provider: "fake",
    observed_session_id: "synthetic-session",
  };
  const origin = {
    run_id: id,
    run_execution_id: id,
    assignment_generation: 1,
    provider_session_id: sessionId,
  };
  const local = (request: unknown) => ({ request, correlation: "synthetic-correlation" });
  const bound = { reference, binding };
  const authority = { revoked: false, execution_ended: false, result_terminal: false };
  const task = {
    id,
    project_id: id,
    state: "active",
    priority: "P2",
    title: "Synthetic",
    punchline: "",
    resource_version: 1,
  };
  const actions = [
    ["authority", "agent_request", local(reference), "agent_authority", authority],
    [
      "get_context",
      "agent_request",
      local(reference),
      "agent_context",
      { context: [], deliveries: [] },
    ],
    ["get_task", "agent_request", local(reference), "agent_task", task],
    [
      "bind_session",
      "agent_request",
      local(reference),
      "agent_binding",
      {
        binding,
        origin,
        observed_at: "2026-10-05T10:00:00Z",
        confirmed_at: "2026-10-05T10:00:01Z",
      },
    ],
    ["bound_authority", "agent_bound_request", local(bound), "agent_authority", authority],
    [
      "add_comment",
      "agent_comment_request",
      local({ ...bound, body: "Synthetic comment" }),
      "agent_comment",
      { id, origin },
    ],
    [
      "update_task",
      "agent_update_request",
      local({ ...bound, expected_version: 1, title: "Synthetic replacement" }),
      "agent_update",
      { task, origin },
    ],
    [
      "report_progress",
      "agent_progress_request",
      local({ ...bound, summary: "Synthetic checkpoint", percent: 0, confidence: 0 }),
      "agent_comment",
      { id, origin },
    ],
    [
      "propose_task",
      "agent_proposal_request",
      local({ ...bound, title: "Synthetic root proposal", priority: "P2" }),
      "agent_proposal",
      { id, state: "proposed", origin },
    ],
  ] as const;
  const fixtures: Array<{ name: string; document: string; json: string; accept: boolean }> = [];
  const add = (name: string, input: unknown, accept: boolean, document = "local-agent-rpc") =>
    fixtures.push({
      name,
      document,
      json: typeof input === "string" ? input : JSON.stringify(input),
      accept,
    });
  const envelope = (method: string, direction: string, payload?: unknown) => ({
    schema_version: 2,
    request_id: id,
    method: "mcp.v2." + method,
    direction,
    ...(payload ? { payload } : {}),
  });
  for (const [method, inputField, input, resultField, result] of actions) {
    add(method + ".request", envelope(method, "request", { [inputField]: input }), true);
    add(method + ".response", envelope(method, "response", { [resultField]: result }), true);
    add(
      method + ".error",
      {
        ...envelope(method, "response"),
        error: {
          schema_version: 1,
          category: "unavailable",
          code: "offline_rejected",
          message: "Temporarily unavailable.",
        },
      },
      true,
    );
    add(
      method + ".wrong-input",
      envelope(method, "request", { agent_comment: { id, origin } }),
      false,
    );
    add(
      method + ".unknown-field",
      { ...envelope(method, "request", { [inputField]: input }), offline_permission: true },
      false,
    );
  }
  add(
    "propose_task.child-request",
    envelope("propose_task", "request", {
      agent_proposal_request: local({
        ...bound,
        title: "Synthetic child proposal",
        priority: "P2",
        parent_task_id: id,
      }),
    }),
    true,
  );
  add(
    "propose_task.child-ready-response",
    envelope("propose_task", "response", { agent_proposal: { id, state: "ready", origin } }),
    true,
  );
  add(
    "propose_task.invalid-state-response",
    envelope("propose_task", "response", { agent_proposal: { id, state: "active", origin } }),
    false,
  );
  const read = envelope("authority", "request", { agent_request: local(reference) });
  add("v2-as-v1-document", read, false, "local-rpc");
  add("v1-as-v2-document", { ...read, schema_version: 1 }, false);
  add("unknown-version", { ...read, schema_version: 3 }, false);
  add("legacy-method", { ...read, method: "mcp.authority" }, false);
  add("undeclared-method", { ...read, method: "mcp.v2.proxy" }, false);
  add("event-direction", { ...read, direction: "event" }, false);
  add(
    "ambiguous-version",
    JSON.stringify(read).replace('"schema_version":2', '"schema_version":1,"schema_version":2'),
    false,
  );
  add(
    "oversized-comment",
    envelope("add_comment", "request", {
      agent_comment_request: local({ ...bound, body: "x".repeat(2049) }),
    }),
    false,
  );
  add(
    "caller-actor",
    envelope("add_comment", "request", {
      agent_comment_request: local({ ...bound, body: "Synthetic", actor_human_id: id }),
    }),
    false,
  );
  add(
    "empty-update",
    envelope("update_task", "request", {
      agent_update_request: local({ ...bound, expected_version: 1 }),
    }),
    false,
  );
  add(
    "progress-range",
    envelope("report_progress", "request", {
      agent_progress_request: local({ ...bound, summary: "Synthetic", percent: 101 }),
    }),
    false,
  );
  add(
    "proposal-workflow",
    envelope("propose_task", "request", {
      agent_proposal_request: local({ ...bound, title: "Synthetic", state: "ready" }),
    }),
    false,
  );
  add(
    "success-with-error",
    {
      ...envelope("authority", "response", { agent_authority: authority }),
      error: {
        schema_version: 1,
        category: "unavailable",
        code: "offline_rejected",
        message: "Temporarily unavailable.",
      },
    },
    false,
  );
  const directory = path.join(root, "protocol/fixtures/v2");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "local-agent-rpc.json"),
    JSON.stringify({ document: "local-agent-rpc", schema_version: 2, fixtures }, null, 2) + "\n",
  );
}

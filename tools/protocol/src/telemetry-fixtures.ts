// ABOUTME: Generates deterministic versioned telemetry and genuine acknowledgement fixtures.
// ABOUTME: Keeps frozen v1 messages separate while exercising closed payloads and nullable counters.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function generateTelemetryFixtures(root: string): Promise<void> {
  const item = {
    schema_version: 2,
    event_id: "01K6R7DT00AAAAAAAAAAAAAAAA",
    source_stream_id: "01K6R7DT00BBBBBBBBBBBBBBBB",
    source_sequence: 1,
    run_execution_id: "01K6R7DT00CCCCCCCCCCCCCCCC",
    assignment_generation: 7,
    occurred_at: "2026-10-06T00:00:00.000Z",
    capture_origin: "hook_inbox",
    provider_session_id: "synthetic-session",
    kind: "turn_started",
    payload: { activity_id: "synthetic-turn" },
  };
  const tokens = {
    ...item,
    kind: "progress_reported",
    payload: {
      measurement: "tokens",
      usage_id: "synthetic-turn",
      basis: "turn_delta",
      model: "synthetic-model",
      quality: "provider_reported",
      tokens: { input: 120, output: 34, cache_read: 100, cache_write: null, reasoning: 5 },
    },
  };
  const fixtures: Array<{
    name: string;
    document: string;
    json: string;
    accept: boolean;
    canonical_sha256?: string;
  }> = [];
  const add = (name: string, document: string, value: unknown, accept: boolean) => {
    const json = typeof value === "string" ? value : JSON.stringify(value);
    const canonical = JSON.stringify(value, (_key, nested: unknown) =>
      nested && typeof nested === "object" && !Array.isArray(nested)
        ? Object.fromEntries(
            Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          )
        : nested,
    );
    fixtures.push({
      name,
      document,
      json,
      accept,
      ...(accept ? { canonical_sha256: createHash("sha256").update(canonical).digest("hex") } : {}),
    });
  };
  const telemetry = (name: string, value: unknown, accept = true) =>
    add(name, "runner-telemetry-submission", value, accept);
  for (const kind of [
    "turn_started",
    "turn_stopped",
    "turn_failed",
    "tool_started",
    "tool_finished",
    "tool_failed",
  ]) {
    telemetry(kind, { ...item, kind });
    if (kind.startsWith("tool"))
      telemetry(kind + ".parent", {
        ...item,
        kind,
        payload: { ...item.payload, parent_turn_id: "synthetic-parent" },
      });
  }
  telemetry("tokens", tokens);
  for (const quality of ["stream_derived", "estimated"])
    telemetry("tokens." + quality, { ...tokens, payload: { ...tokens.payload, quality } });
  telemetry("tokens.unavailable", {
    ...tokens,
    payload: {
      ...tokens.payload,
      model: null,
      quality: "unavailable",
      tokens: { input: null, output: null, cache_read: null, cache_write: null, reasoning: null },
    },
  });
  telemetry("tokens.zero", {
    ...tokens,
    payload: { ...tokens.payload, tokens: { ...tokens.payload.tokens, input: 0 } },
  });
  telemetry(
    "tokens.raw-fractional",
    JSON.stringify(tokens).replace('"input":120', '"input":9007199254740991.1'),
    false,
  );
  telemetry(
    "tokens.raw-rounded-zero",
    JSON.stringify(tokens).replace('"input":120', '"input":1e-400'),
    false,
  );
  telemetry(
    "version.raw-rounded",
    JSON.stringify(item).replace('"schema_version":2', '"schema_version":2.0000000000000001'),
    false,
  );
  telemetry("unknown.root", { ...item, provider: "codex" }, false);
  telemetry(
    "unknown.payload",
    { ...item, payload: { ...item.payload, text: "synthetic-private-body" } },
    false,
  );
  telemetry(
    "turn.parent",
    { ...item, payload: { ...item.payload, parent_turn_id: "parent" } },
    false,
  );
  telemetry(
    "tokens.bad-basis",
    { ...tokens, payload: { ...tokens.payload, basis: "cumulative" } },
    false,
  );
  telemetry(
    "tokens.negative",
    { ...tokens, payload: { ...tokens.payload, tokens: { ...tokens.payload.tokens, input: -1 } } },
    false,
  );
  telemetry(
    "tokens.unsafe",
    {
      ...tokens,
      payload: { ...tokens.payload, tokens: { ...tokens.payload.tokens, input: 9007199254740992 } },
    },
    false,
  );
  telemetry(
    "tokens.unavailable-count",
    { ...tokens, payload: { ...tokens.payload, quality: "unavailable" } },
    false,
  );
  telemetry(
    "tokens.missing-counter",
    {
      ...tokens,
      payload: {
        ...tokens.payload,
        tokens: { input: 1, output: 2, cache_read: null, cache_write: null },
      },
    },
    false,
  );
  telemetry(
    "tokens.extra-counter",
    { ...tokens, payload: { ...tokens.payload, tokens: { ...tokens.payload.tokens, total: 1 } } },
    false,
  );
  telemetry(
    "tokens.all-null-exact",
    {
      ...tokens,
      payload: {
        ...tokens.payload,
        tokens: { input: null, output: null, cache_read: null, cache_write: null, reasoning: null },
      },
    },
    false,
  );
  telemetry("activity.absent", { ...item, payload: {} }, false);
  telemetry("activity.null", { ...item, payload: { activity_id: null } }, false);
  telemetry("activity.bound", { ...item, payload: { activity_id: "x".repeat(129) } }, false);
  telemetry("version.old", { ...item, schema_version: 1 }, false);
  telemetry("business.kind", { ...item, kind: "result_submitted" }, false);
  add("frozen.v1.rejects-typed", "runner-event-submission", { ...item, schema_version: 1 }, false);
  add(
    "capabilities",
    "runner-event-capabilities",
    { schema_version: 1, accepted_event_versions: [1, 2] },
    true,
  );
  for (const accepted_event_versions of [[1], [2, 1], [1, 1, 2]])
    add(
      "capabilities." + accepted_event_versions.join("-"),
      "runner-event-capabilities",
      { schema_version: 1, accepted_event_versions },
      false,
    );
  const ack = {
    schema_version: 1,
    workspace_id: "01K6R7DT00DDDDDDDDDDDDDDDD",
    high_water_cursor: 2,
    dispositions: [
      {
        schema_version: 1,
        event_id: item.event_id,
        source_stream_id: item.source_stream_id,
        source_sequence: 1,
        disposition: "accepted",
      },
    ],
  };
  add("ack.actual", "runner-event-ingest-result", ack, true);
  add(
    "ack.no-committed-cursor",
    "runner-event-ingest-result",
    { ...ack, high_water_cursor: 0 },
    true,
  );
  add("ack.extra", "runner-event-ingest-result", { ...ack, secret: "synthetic" }, false);
  add(
    "ack.missing-workspace",
    "runner-event-ingest-result",
    { schema_version: 1, high_water_cursor: 2, dispositions: ack.dispositions },
    false,
  );
  const directory = path.join(root, "protocol/fixtures/v2");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "runner-telemetry-submission.json"),
    JSON.stringify(
      {
        owner_command: "pnpm protocol:generate",
        document: "runner-telemetry-submission",
        schema_version: 2,
        fixtures,
      },
      null,
      2,
    ) + "\n",
  );
}

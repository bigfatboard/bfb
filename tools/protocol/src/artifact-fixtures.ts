// ABOUTME: Generates closed online artifact requests, phase replies and local v6 boundary fixtures.
// ABOUTME: Keeps deterministic synthetic recovery identities separate from frozen earlier contracts.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, nested: unknown) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
    return Object.fromEntries(
      Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const wire = (value: unknown) =>
  canonical(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
const without = (value: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([field]) => field !== key));

export async function generateArtifactFixtures(root: string): Promise<void> {
  const id = "01K6R7DT00AAAAAAAAAAAAAAAA";
  const reference = {
    schema_version: 1,
    run_execution_id: id,
    assignment_generation: 1,
    request_id: "artifact-fixture-001",
  };
  const binding = {
    provider_session_id: id,
    provider: "fake",
    observed_session_id: "synthetic-artifact-session",
  };
  const request = {
    reference,
    binding,
    format: "markdown",
    role: "review",
    declared_size: 16,
    expected_digest: hash("synthetic bytes\n"),
  };
  const local = {
    correlation: "synthetic-artifact-correlation",
    request: { reference, path: "review/plan.md", format: "markdown", role: "review" },
  };
  const operationKey = "agent:" + hash(canonical({ tool: "publish_artifact", ...reference }));
  const shared = {
    schema_version: 1,
    operation_key: operationKey,
    artifact_id: id,
    version_id: id,
    format: "markdown",
    role: "review",
    content_hash: request.expected_digest,
    size: 16,
    origin: { run_id: id, run_execution_id: id, assignment_generation: 1, provider_session_id: id },
  };
  const upload = {
    origin: "https://artifacts.synthetic.example",
    grant_id: id,
    secret: "A".repeat(43),
    expires_at: "2026-10-06T12:15:00.000Z",
  };
  const prepare = { ...shared, stage: "upload_required", upload, available_at: null };
  const ready = { ...shared, stage: "finalize_required", upload: null, available_at: null };
  const available = {
    ...shared,
    stage: "available",
    upload: null,
    available_at: "2026-10-06T12:00:01.000Z",
  };
  const result = { ...shared, state: "available", available_at: available.available_at };
  const envelope = {
    schema_version: 6,
    request_id: id,
    method: "mcp.v6.publish_artifact",
    direction: "request",
    payload: { agent_artifact_request: local },
  };
  const response = { ...envelope, direction: "response", payload: { agent_artifact: result } };
  const error = {
    schema_version: 1,
    category: "unavailable",
    code: "work_unavailable",
    message: "Publication may have applied; retry the same request identity.",
  };
  const fixtures: Array<{
    name: string;
    document: string;
    json: string;
    accept: boolean;
    canonical_sha256?: string;
  }> = [];
  const add = (name: string, document: string, value: unknown, accept: boolean, raw?: string) => {
    const json = raw ?? wire(value);
    fixtures.push({
      name,
      document,
      json,
      accept,
      ...(accept ? { canonical_sha256: hash(wire(value)) } : {}),
    });
  };
  const docs: Array<[string, Record<string, unknown>]> = [
    ["agent-artifact-request", request],
    ["agent-artifact-local-request", local],
    ["agent-artifact-prepare-result", prepare],
    ["agent-artifact-result", result],
    ["local-agent-artifact-rpc", envelope],
  ];
  for (const [document, value] of docs) {
    add(document + "-minimal", document, value, true);
    for (const key of Object.keys(value))
      add(document + "-missing-" + key, document, without(value, key), false);
    add(document + "-unknown-field", document, { ...value, unexpected: true }, false);
    add(
      document + "-duplicate-key",
      document,
      value,
      false,
      wire(value).replace("{", '{"unexpected":1,"unexpected":2,'),
    );
  }
  add("prepare-finalize-required", "agent-artifact-prepare-result", ready, true);
  add("prepare-available", "agent-artifact-prepare-result", available, true);
  add("envelope-success", "local-agent-artifact-rpc", response, true);
  add(
    "envelope-error",
    "local-agent-artifact-rpc",
    { ...without(envelope, "payload"), direction: "response", error },
    true,
  );
  add("request-existing-artifact", "agent-artifact-request", { ...request, artifact_id: id }, true);
  add(
    "local-expected-binding",
    "agent-artifact-local-request",
    { ...local, expected_binding: binding },
    true,
  );
  add(
    "local-equivalent-safe-file",
    "agent-artifact-local-request",
    { ...local, request: { ...local.request, path: "other/same-bytes.md" } },
    true,
  );
  add(
    "request-log-at-limit",
    "agent-artifact-request",
    { ...request, format: "log", role: "log", declared_size: 1048576 },
    true,
  );
  add(
    "request-review-at-limit",
    "agent-artifact-request",
    { ...request, declared_size: 5242880 },
    true,
  );
  for (const value of [0, -1, 1.5, 5242881, 9007199254740992])
    add(
      "request-size-" + value,
      "agent-artifact-request",
      { ...request, declared_size: value },
      false,
    );
  add(
    "request-log-over-limit",
    "agent-artifact-request",
    { ...request, format: "log", role: "log", declared_size: 1048577 },
    false,
  );
  add(
    "request-integral-number-spelling",
    "agent-artifact-request",
    request,
    true,
    wire(request).replace('"declared_size":16', '"declared_size":1.6e1'),
  );
  add(
    "request-fraction-before-rounding",
    "agent-artifact-request",
    request,
    false,
    wire(request).replace('"declared_size":16', '"declared_size":16.000000000000000001'),
  );
  add(
    "request-underflow",
    "agent-artifact-request",
    request,
    false,
    wire(request).replace('"declared_size":16', '"declared_size":1e-10000'),
  );
  for (const [field, value] of Object.entries({
    workspace_id: id,
    run_id: id,
    version_id: id,
    control_url: "https://other.example",
    path: "private.md",
    grant_id: id,
    secret: "A".repeat(43),
    r2_key: "forbidden",
  })) {
    add(
      "request-forbids-" + field,
      "agent-artifact-request",
      { ...request, [field]: value },
      false,
    );
    add(
      "local-forbids-" + field,
      "agent-artifact-local-request",
      { ...local, request: { ...local.request, [field]: value } },
      field === "path",
    );
  }
  for (const [field, value] of Object.entries({
    upload,
    r2_key: "forbidden",
    path: "private.md",
    credential: "synthetic",
  }))
    add("result-forbids-" + field, "agent-artifact-result", { ...result, [field]: value }, false);
  add("optional-artifact-null", "agent-artifact-request", { ...request, artifact_id: null }, false);
  add(
    "optional-binding-null",
    "agent-artifact-local-request",
    { ...local, expected_binding: null },
    false,
  );
  add(
    "local-control-character",
    "agent-artifact-local-request",
    { ...local, request: { ...local.request, path: "bad\nname.md" } },
    false,
  );
  add(
    "local-max-path",
    "agent-artifact-local-request",
    { ...local, request: { ...local.request, path: "a".repeat(4096) } },
    true,
  );
  add(
    "local-path-over-limit",
    "agent-artifact-local-request",
    { ...local, request: { ...local.request, path: "a".repeat(4097) } },
    false,
  );
  add(
    "local-utf8-byte-bound",
    "agent-artifact-local-request",
    { ...local, request: { ...local.request, path: "😀".repeat(3072) } },
    false,
  );
  for (const phase of [prepare, ready, available]) {
    add(
      phase.stage + "-wrong-upload-branch",
      "agent-artifact-prepare-result",
      { ...phase, upload: phase.upload ? null : upload },
      false,
    );
    add(
      phase.stage + "-wrong-time-branch",
      "agent-artifact-prepare-result",
      { ...phase, available_at: phase.available_at ? null : available.available_at },
      false,
    );
  }
  for (const origin of [
    "https://user@host.example",
    "https://host.example/",
    "https://host.example?secret=x",
    "https://host.example#fragment",
    "file://private",
    "https://host.example bad",
  ])
    add(
      "upload-origin-" + origin,
      "agent-artifact-prepare-result",
      { ...prepare, upload: { ...upload, origin } },
      false,
    );
  add(
    "upload-local-loopback",
    "agent-artifact-prepare-result",
    { ...prepare, upload: { ...upload, origin: "http://127.0.0.1:4187" } },
    true,
  );
  add(
    "upload-short-secret",
    "agent-artifact-prepare-result",
    { ...prepare, upload: { ...upload, secret: "A".repeat(42) } },
    false,
  );
  add(
    "upload-expiry-offset",
    "agent-artifact-prepare-result",
    { ...prepare, upload: { ...upload, expires_at: "2026-10-06T12:15:00+03:00" } },
    false,
  );
  add(
    "result-missing-session-origin",
    "agent-artifact-result",
    { ...result, origin: without(result.origin, "provider_session_id") },
    false,
  );
  add(
    "digest-prefixed",
    "agent-artifact-request",
    { ...request, expected_digest: "sha256:" + request.expected_digest },
    false,
  );
  add(
    "digest-uppercase",
    "agent-artifact-request",
    { ...request, expected_digest: request.expected_digest.toUpperCase() },
    false,
  );
  add(
    "envelope-old-version",
    "local-agent-artifact-rpc",
    { ...envelope, schema_version: 5 },
    false,
  );
  add(
    "envelope-old-method",
    "local-agent-artifact-rpc",
    { ...envelope, method: "artifact.publish" },
    false,
  );
  add(
    "envelope-wrong-direction",
    "local-agent-artifact-rpc",
    { ...envelope, direction: "response" },
    false,
  );
  add("envelope-mixed-response", "local-agent-artifact-rpc", { ...response, error }, false);
  add(
    "envelope-mixed-payload",
    "local-agent-artifact-rpc",
    { ...response, payload: { ...response.payload, agent_artifact_request: local } },
    false,
  );
  add(
    "envelope-no-offline-receipt",
    "local-agent-artifact-rpc",
    { ...response, payload: { agent_artifact_receipt: { delivery_state: "pending_sync" } } },
    false,
  );
  for (const document of [
    "local-rpc",
    "local-agent-rpc",
    "local-agent-work-rpc",
    "local-agent-attention-rpc",
    "local-agent-result-rpc",
  ])
    add("frozen-" + document + "-rejects-artifact-v6", document, envelope, false);
  for (const [document, value, maximum] of [
    ["agent-artifact-request", request, 4096],
    ["agent-artifact-local-request", local, 12288],
    ["agent-artifact-prepare-result", prepare, 4096],
    ["agent-artifact-result", result, 2048],
    ["local-agent-artifact-rpc", envelope, 16384],
  ] as const)
    add(document + "-raw-byte-bound", document, value, false, wire(value) + " ".repeat(maximum));
  const directory = path.join(root, "protocol/fixtures/v6");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "local-agent-artifact-rpc.json"),
    JSON.stringify(
      {
        owner_command: "pnpm protocol:generate",
        document: "local-agent-artifact-rpc",
        schema_version: 6,
        synthetic: true,
        operation_key: operationKey,
        canonical_request_sha256: hash(canonical(request)),
        fixtures,
      },
      null,
      2,
    ) + "\n",
  );
}

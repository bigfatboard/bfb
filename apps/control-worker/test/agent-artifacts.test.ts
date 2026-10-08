// ABOUTME: Exercises fixed artifact phases with actual byte-bound runner possession and Hub authority.
// ABOUTME: Separates ephemeral grants from canonical publication, bounded metadata and explicit recovery.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIX,
  randomUlid,
  recordVerifiedUpload,
  redeemUploadGrant,
  runnerChallengeTranscript,
  runnerHash,
  type RunnerChallenge,
} from "@bfb/domain";
import {
  decodeWireDocument,
  type AgentArtifactRequest,
  type AgentArtifactResult,
} from "@bfb/protocol";
import { captureFixture } from "../../../packages/domain/test/agent-capture-fixture.js";
import { LAUNCH_NOW } from "../../../packages/domain/test/launch-fixture.js";
import { handleAgentWorkApi } from "../src/api/agent-work.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { createControlApp } from "../src/routes.js";
import { AUTH_TEST_ENV, openAuthTestContext } from "./auth-helpers.js";

const ORIGIN = AUTH_TEST_ENV.APP_ORIGIN;
const ARTIFACT_ORIGIN = "https://artifacts.bfb.example.test";
const BYTES = new TextEncoder().encode("# V01-PRIVATE-ARTIFACT-BYTES\n");
interface Prepared {
  stage: "upload_required" | "finalize_required" | "available";
  operation_key: string;
  artifact_id: string;
  version_id: string;
  upload: null | { origin: string; grant_id: string; secret: string; expires_at: string };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(LAUNCH_NOW);
});
afterEach(() => vi.useRealTimers());

async function fixture() {
  const context = openAuthTestContext(LAUNCH_NOW);
  const f = await captureFixture(context.db, false);
  const namespace = createTestWorkspaceHubNamespace(f.db);
  const env = {
    DB: {},
    ARTIFACTS: {},
    ASSETS: {},
    JOBS: {},
    JOBS_DLQ: {},
    WORKSPACE_HUB: namespace,
    APP_ORIGIN: ORIGIN,
    ARTIFACT_ORIGIN,
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  } as unknown as ControlBindings;
  const prefix = `/runner/workspaces/${FIX.workspace}/runners/${f.runner}`;
  const send = (request: Request) =>
    createControlApp(validateControlEnv(env), {
      db: f.db,
      now: LAUNCH_NOW,
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    }).request(request, undefined, env);
  const request = (id = randomUlid()): AgentArtifactRequest => ({
    ...f.bound(id),
    format: "markdown",
    role: "review",
    declared_size: BYTES.length,
    expected_digest: runnerHash(BYTES),
  });
  async function signed(action: string, body: unknown, raw?: string) {
    const bytes = raw ?? JSON.stringify(body),
      path = `${prefix}/work/${action}`;
    const response = await send(
      new Request(`${ORIGIN}${prefix}/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          purpose: "request",
          token: f.token,
          request: { method: "POST", path, body_sha256: runnerHash(bytes) },
        }),
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const challenge = ((await response.json()) as { challenge: RunnerChallenge }).challenge;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      f.key.privateKey,
      runnerChallengeTranscript(challenge),
    );
    const proof = Buffer.from(
      JSON.stringify({
        challenge_id: challenge.challenge_id,
        server_nonce: challenge.server_nonce,
        signature: Buffer.from(signature).toString("base64url"),
        token: f.token,
      }),
    ).toString("base64url");
    return new Request(ORIGIN + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bfb-runner-proof": proof },
      body: bytes,
    });
  }
  const call = async (action: string, body: unknown, raw?: string) =>
    send(await signed(action, body, raw));
  async function prepare(body: AgentArtifactRequest) {
    const response = await call("artifact-prepare", body);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBeLessThanOrEqual(4096);
    expect(decodeWireDocument("agent-artifact-prepare-result", bytes).ok).toBe(true);
    return JSON.parse(new TextDecoder().decode(bytes)) as Prepared;
  }
  // These mounted-route fixtures stand in for physically verified bytes; the
  // real Artifact Worker/R2 harness owns content inspection and storage proof.
  async function receipt(prepared: Prepared) {
    if (!prepared.upload) throw new Error("fixture requires a fresh upload grant");
    const grant = prepared.upload;
    const consumed = await f.db.withTransaction((tx) =>
      redeemUploadGrant(tx, { grantId: grant.grant_id, secret: grant.secret, now: LAUNCH_NOW }),
    );
    await f.db.withTransaction((tx) =>
      recordVerifiedUpload(tx, {
        grantId: consumed.grantId,
        consumeAttemptId: consumed.consumeAttemptId,
        contentHash: runnerHash(BYTES),
        size: BYTES.length,
        now: LAUNCH_NOW,
      }),
    );
  }
  async function count(table: string) {
    return ((await f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()) as { n: number }).n;
  }
  return { ...f, namespace, env, prefix, request, send, signed, call, prepare, receipt, count };
}

describe("fixed agent artifact routes", () => {
  it("publishes one closed canonical result with an ephemeral deployment-origin grant", async () => {
    const f = await fixture(),
      input = f.request(),
      prepared = await f.prepare(input);
    expect(prepared.stage).toBe("upload_required");
    expect(prepared.upload).toEqual({
      origin: ARTIFACT_ORIGIN,
      grant_id: expect.any(String),
      secret: expect.any(String),
      expires_at: expect.any(String),
    });
    const early = await f.call("artifact-finalize", input);
    expect(early.status).toBe(403);
    await f.receipt(prepared);
    expect(await f.prepare(input)).toMatchObject({
      stage: "finalize_required",
      upload: null,
      version_id: prepared.version_id,
    });
    const finalized = await f.call("artifact-finalize", input);
    expect(finalized.status, await finalized.clone().text()).toBe(200);
    const encoded = new Uint8Array(await finalized.arrayBuffer());
    expect(encoded.length).toBeLessThanOrEqual(2048);
    expect(decodeWireDocument("agent-artifact-result", encoded).ok).toBe(true);
    const result = JSON.parse(new TextDecoder().decode(encoded)) as AgentArtifactResult;
    expect(result).toMatchObject({
      state: "available",
      version_id: prepared.version_id,
      operation_key: prepared.operation_key,
      content_hash: runnerHash(BYTES),
      size: BYTES.length,
      origin: {
        run_id: f.launch.run_id,
        run_execution_id: f.final.run_execution_id,
        assignment_generation: f.final.assignment_generation,
        provider_session_id: f.binding.provider_session_id,
      },
    });
    expect(await f.prepare(input)).toMatchObject({
      stage: "available",
      upload: null,
      version_id: prepared.version_id,
    });
    expect(await (await f.call("artifact-finalize", input)).json()).toEqual(result);
    expect(await f.count("artifact_versions")).toBe(1);
    const stored = JSON.stringify({
      grants: await f.db.prepare("SELECT * FROM artifact_upload_grants").all(),
      sources: await f.db.prepare("SELECT * FROM artifact_agent_grants").all(),
      operations: await f.db.prepare("SELECT * FROM artifact_agent_operations").all(),
      events: await f.db.prepare("SELECT payload_json FROM semantic_events").all(),
      audit: await f.db.prepare("SELECT payload_json FROM audit_events").all(),
      outbox: await f.db.prepare("SELECT payload_json FROM artifact_audit_outbox").all(),
      cache: await f.db.prepare("SELECT result_json FROM idempotency_records").all(),
    });
    expect(stored).not.toContain(prepared.upload!.secret);
    expect(stored).not.toContain("V01-PRIVATE-ARTIFACT-BYTES");
    expect(JSON.stringify(result)).not.toMatch(/r2_key|grant_id|secret|https:\/\//);
  });

  it("recovers lost prepare and finalize replies without another version or private secret cache", async () => {
    const f = await fixture(),
      input = f.request(),
      get = f.namespace.get.bind(f.namespace);
    const lost = new Set<string>();
    vi.spyOn(f.namespace, "get").mockImplementation((id) => {
      const stub = get(id);
      return {
        async fetch(url: RequestInfo | URL, init?: RequestInit) {
          const command = JSON.parse(String(init?.body)).commandName as string;
          const response = await stub.fetch(url, init);
          if (
            ["artifact.agent_prepare", "artifact.agent_finalize"].includes(command) &&
            !lost.has(command)
          ) {
            lost.add(command);
            await response.arrayBuffer();
            throw Error("synthetic lost committed artifact reply");
          }
          return response;
        },
      } as DurableObjectStub;
    });
    expect((await f.call("artifact-prepare", input)).status).toBe(503);
    const prepared = await f.prepare(input);
    expect(await f.count("artifact_versions")).toBe(1);
    expect(await f.count("artifact_upload_grants")).toBe(2);
    await f.receipt(prepared);
    expect((await f.call("artifact-finalize", input)).status).toBe(503);
    const retry = await f.call("artifact-finalize", input);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      state: "available",
      version_id: prepared.version_id,
    });
    expect(await f.count("artifact_versions")).toBe(1);
    expect(await f.count("artifact_upload_receipts")).toBe(1);
  });

  it("preserves changed-input conflict but checks closure before cached result or conflict", async () => {
    const f = await fixture(),
      input = f.request(),
      prepared = await f.prepare(input);
    const changed = { ...input, expected_digest: "b".repeat(64) };
    const conflict = await f.call("artifact-prepare", changed);
    expect(conflict.status).toBe(403);
    expect(await conflict.json()).toMatchObject({ error: "request_conflict" });
    expect((await f.prepare(input)).version_id).toBe(prepared.version_id);
    await f.receipt(prepared);
    expect((await f.call("artifact-finalize", input)).status).toBe(200);
    await f.db
      .prepare("UPDATE provider_sessions SET state='ended',ended_at=? WHERE id=?")
      .run(LAUNCH_NOW, f.binding.provider_session_id);
    for (const action of ["artifact-prepare", "artifact-finalize"])
      for (const body of [input, changed]) {
        const denied = await f.call(action, body);
        expect(denied.status).toBe(403);
        const projected = (await denied.json()) as { error: string };
        expect(projected.error).not.toBe("request_conflict");
        expect(JSON.stringify(projected)).not.toContain(prepared.version_id);
      }
    expect(
      await f.db.prepare("SELECT state FROM artifact_versions WHERE id=?").get(prepared.version_id),
    ).toEqual({ state: "available" });
  });

  it("rejects caller scope, origins, credentials and wrong-byte possession before publication", async () => {
    const f = await fixture(),
      input = f.request();
    for (const extra of [
      { origin: ARTIFACT_ORIGIN },
      { workspace_id: FIX.workspace },
      { version_id: randomUlid() },
      { path: "private.md" },
      { grantSecretHash: "c".repeat(64) },
      { artifact_id: null },
    ]) {
      expect((await f.call("artifact-prepare", { ...input, ...extra })).status).toBe(403);
    }
    for (const headers of [
      { cookie: "synthetic" },
      { authorization: "Bearer synthetic" },
      { origin: ORIGIN },
    ]) {
      const signed = await f.signed("artifact-prepare", input),
        altered = new Headers(signed.headers);
      for (const [name, value] of Object.entries(headers)) altered.set(name, value);
      expect((await f.send(new Request(signed, { headers: altered }))).status).toBe(403);
    }
    const signed = await f.signed("artifact-prepare", input);
    expect(
      (
        await f.send(
          new Request(signed, {
            method: "POST",
            body: JSON.stringify({ ...input, expected_digest: "b".repeat(64) }),
          }),
        )
      ).status,
    ).toBe(403);
    expect(await f.count("artifact_versions")).toBe(0);
  });

  it("bounds actual signed JSON bytes and does not create an operation for oversized input", async () => {
    const f = await fixture(),
      input = f.request(),
      json = JSON.stringify(input);
    expect(
      (await f.call("artifact-prepare", input, json + " ".repeat(4096 - Buffer.byteLength(json))))
        .status,
    ).toBe(200);
    expect(
      (await f.call("artifact-prepare", input, json + " ".repeat(4097 - Buffer.byteLength(json))))
        .status,
    ).toBe(403);
    expect(await f.count("artifact_versions")).toBe(1);
    expect(await f.count("artifact_upload_grants")).toBe(1);
  });

  it("keeps prepare in the twenty-attempt mutation class", async () => {
    const f = await fixture();
    for (let attempt = 0; attempt < 21; attempt++) {
      const response = await f.call("artifact-prepare", f.request());
      expect(response.status).toBe(attempt < 20 ? 200 : 403);
      await response.arrayBuffer();
    }
    expect(await f.count("artifact_versions")).toBe(20);
  });

  it("fails closed before creation when the server artifact origin is unavailable", async () => {
    const f = await fixture(),
      request = await f.signed("artifact-prepare", f.request());
    const response = await handleAgentWorkApi(request, {
      db: f.db,
      now: LAUNCH_NOW,
      jurisdiction: "eu",
      appOrigin: ORIGIN,
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      workspaceHubNs: f.namespace,
    });
    expect(response.status).toBe(503);
    expect(await f.count("artifact_versions")).toBe(0);
  });

  it("refuses an unexpected private field on a successful Hub finalization reply", async () => {
    const f = await fixture(),
      input = f.request(),
      prepared = await f.prepare(input);
    await f.receipt(prepared);
    const get = f.namespace.get.bind(f.namespace);
    const intercepted = vi.spyOn(f.namespace, "get").mockImplementation((id) => {
      const stub = get(id);
      return {
        async fetch(url: RequestInfo | URL, init?: RequestInit) {
          const response = await stub.fetch(url, init);
          if (JSON.parse(String(init?.body)).commandName !== "artifact.agent_finalize")
            return response;
          const outcome = (await response.json()) as {
            ok: boolean;
            result: Record<string, unknown>;
          };
          expect(outcome.ok).toBe(true);
          return Response.json({
            ...outcome,
            result: { ...outcome.result, private_value: "MUST-NOT-ESCAPE" },
          });
        },
      } as DurableObjectStub;
    });
    const response = await f.call("artifact-finalize", input);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("MUST-NOT-ESCAPE");
    intercepted.mockRestore();
    expect((await f.call("artifact-finalize", input)).status).toBe(200);
  });
});

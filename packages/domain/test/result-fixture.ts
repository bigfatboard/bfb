// ABOUTME: Builds canonical result launch/session authority with independent proof-bound permission.
// ABOUTME: Signs synthetic result captures and exposes strict staged D1 fault verification.

import { adaptD1, type D1Like, type D1StatementLike, type SqlDatabase } from "@bfb/db";
import {
  canonicalAgentWriteRequest,
  type AgentResultRequest,
  type AgentResultCapture,
  type AgentResultConfirmationRequest,
  type AgentResultConfirmationResult,
} from "@bfb/protocol";
import { FIX } from "../src/fixtures.js";
import { resultCaptureConfirmationCommand, resultConfirmationKey } from "../src/agent-results.js";
import { agentWorkKey } from "../src/agent-work.js";
import { canonicalLaunchJson } from "../src/launch-state.js";
import { runnerHash } from "../src/runner-crypto.js";
import { randomUlid } from "../src/ids.js";
import { captureFixture } from "./agent-capture-fixture.js";
import { success } from "./launch-fixture.js";

export async function resultFixture(db?: SqlDatabase, enabled = true, tightened = false) {
  const f = await captureFixture(
    db,
    false,
    tightened,
    enabled ? { offlineResults: { allow_submit_result: true, max_pending_age_seconds: 300 } } : {},
  );
  const request = (id = randomUlid()): AgentResultRequest => ({
    ...f.bound(id),
    summary: " PRIVATE_RESULT_SUMMARY <>& \u2028 \u2029 \\u2028 ",
    limitations: " PRIVATE_RESULT_LIMITATION ",
    evidence_refs: [{ kind: "comment", ref: "PRIVATE_RESULT_EVIDENCE", version: "v1" }],
    git_branch: "synthetic/result",
    git_commit: "a".repeat(40),
    git_dirty: false,
  });
  const confirmationRequest = (id = randomUlid()): AgentResultConfirmationRequest => ({
    ...f.confirmationRequest(id),
  });
  const confirm = (input = confirmationRequest()) =>
    f.hub.execute(resultCaptureConfirmationCommand, {
      workspaceId: FIX.workspace,
      actorRunnerId: f.runner,
      authorizationEpoch: f.principal.authorizationEpoch,
      idempotencyKey: resultConfirmationKey(input),
      input: { principal: f.principal, request: input },
    });
  async function sign<T extends object>(unsigned: T) {
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      f.key.privateKey,
      new TextEncoder().encode(`BFB-AGENT-RESULT-CAPTURE-V1\n${canonicalLaunchJson(unsigned)}\n`),
    );
    return { ...unsigned, signature: Buffer.from(signature).toString("base64url") };
  }
  async function capture(
    input: AgentResultRequest,
    confirmation = undefined as AgentResultConfirmationResult | undefined,
  ): Promise<AgentResultCapture> {
    const original = confirmation ?? success(await confirm());
    return sign({
      schema_version: 1 as const,
      confirmation: original,
      operation: {
        command_name: "result.submit" as const,
        tool: "bfb_submit_result" as const,
        operation_schema_version: 1 as const,
        operation_key: agentWorkKey("submit_result", input.reference),
        request_id: input.reference.request_id,
        payload_hash: `sha256:${runnerHash(canonicalAgentWriteRequest("result.submit", Buffer.from(JSON.stringify(input))))}`,
        expected_version: null,
        target_task_id: f.task.id,
        parent_task_id: null,
      },
      admission_mode: "offline_admitted" as const,
      admitted_permission: original.configured_permission,
      captured_at: new Date().toISOString(),
      intent_expires_at: new Date(
        Date.now() + original.configured_permission.max_pending_age_seconds * 1000,
      ).toISOString(),
    });
  }
  return {
    ...f,
    request,
    confirmationRequest,
    confirmResult: confirm,
    resultCapture: capture,
    signResult: sign,
  };
}

export function resultStagedD1(db: SqlDatabase, beforeBatch?: () => Promise<void>) {
  const entries = new Map<D1StatementLike, { sql: string; params: unknown[] }>();
  let failure: RegExp | undefined;
  const binding: D1Like = {
    prepare(sql) {
      const entry = { sql, params: [] as unknown[] };
      const statement: D1StatementLike = {
        bind(...params) {
          entry.params = params;
          return statement;
        },
        first: async () => (await db.prepare(sql).get(...entry.params)) ?? null,
        all: async () => ({ results: await db.prepare(sql).all(...entry.params) }),
        run: async () => ({ meta: await db.prepare(sql).run(...entry.params) }),
      };
      entries.set(statement, entry);
      return statement;
    },
    batch: async (pending) => {
      await beforeBatch?.();
      return db.withTransaction(async (tx) => {
        const results = [];
        for (const statement of pending) {
          const entry = entries.get(statement)!;
          const meta = await tx.prepare(entry.sql).run(...entry.params);
          if (failure?.test(entry.sql)) throw Error("synthetic-result-batch-failure");
          results.push({ meta });
        }
        return results;
      });
    },
  };
  return {
    db: adaptD1(binding),
    fail(pattern?: RegExp) {
      failure = pattern;
    },
  };
}

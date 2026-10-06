// ABOUTME: Keeps run-creation receipts free of task prose and configuration bodies.
// ABOUTME: Proves cached run creation cannot cross a newly private parent boundary.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub } from "../src/hub.js";
import { createTaskCommand } from "../src/work-commands.js";
import { createRunCommand } from "../src/work-records.js";
import { openDomainDb } from "./helpers.js";

const NOW = "2026-10-06T12:00:00.000Z";
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => vi.useRealTimers());

function request<T>(input: T, idempotencyKey: string) {
  return {
    workspaceId: FIX.workspace,
    actorHumanId: FIX.member,
    authorizationEpoch: 1,
    idempotencyKey,
    input,
    now: NOW,
  };
}

async function fixture() {
  const db = await openDomainDb();
  const hub = new WorkspaceHub(db);
  const created = await hub.execute(
    createTaskCommand,
    request(
      { projectId: FIX.projectA, title: "PRIVATE_RUN_TITLE_CANARY", priority: "P1" },
      "receipt-task",
    ),
  );
  if (!created.ok) throw new Error(created.error.code);
  const input = {
    taskId: created.result.id,
    expectedTaskVersion: 1,
    agentProfileId: FIX.profileCodex,
    workspacePolicyVersion: 1,
    projectPolicyVersion: 1,
    repositoryConfigVersion: 1,
    agentProfileVersion: 1,
  };
  const run = await hub.execute(createRunCommand, request(input, "receipt-run"));
  if (!run.ok) throw new Error(run.error.code);
  return { db, hub, input, run };
}

describe("private run receipt boundary", () => {
  it("retains full authorized responses but emits only metadata in audit, semantic and outbox receipts", async () => {
    const { db, hub, input, run } = await fixture();
    expect(run.result.task.title).toBe("PRIVATE_RUN_TITLE_CANARY");
    expect(JSON.parse(run.result.snapshot.canonicalJson)).toHaveProperty("agent_profile");
    for (const table of ["audit_events", "semantic_events", "outbox_records"]) {
      const receipts = await db.prepare(`SELECT payload_json FROM ${table}`).all();
      expect(JSON.stringify(receipts)).not.toMatch(
        /PRIVATE_RUN_TITLE_CANARY|canonicalJson|allowed_providers_json/,
      );
    }
    const retry = await hub.execute(createRunCommand, request(input, "receipt-run"));
    expect(retry.ok && retry.replayed).toBe(true);
    const changed = await hub.execute(
      createRunCommand,
      request({ ...input, agentProfileVersion: 2 }, "receipt-run"),
    );
    expect(!changed.ok && changed.error.code).toBe("request_rejected");
  });

  it("rejects cached and new run creation on a private parent even for its creator until certified", async () => {
    const { db, hub, input } = await fixture();
    await db
      .prepare(
        `INSERT INTO task_privacy
      (workspace_id, task_id, owner_human_id, access_version, created_at)
      VALUES (?, ?, ?, 1, ?)`,
      )
      .run(FIX.workspace, input.taskId, FIX.member, NOW);
    for (const key of ["receipt-run", "private-new-run"]) {
      const denied = await hub.execute(createRunCommand, request(input, key));
      expect(!denied.ok && denied.error.code).toBe("not_found");
    }
    expect(await db.prepare("SELECT COUNT(*) AS total FROM runs").get()).toEqual({ total: 1 });
  });
});

// ABOUTME: Verifies the populated pre-agent-work upgrade and durable session/author relationships.
// ABOUTME: Uses synthetic launch records to attack SQLite constraints without claiming native binding proof.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { adaptBetterSqlite3, applyMigrationsForVerification, schemaSnapshot } from "@bfb/db";
import type { AgentWorkRequest } from "@bfb/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bindAgentSessionCommand, agentRunCommentCommand } from "../src/agent-sessions.js";
import { agentWorkKey } from "../src/agent-work.js";
import { FIX } from "../src/fixtures.js";
import { randomUlid } from "../src/ids.js";
import { authorizeLaunchCommand } from "../src/launches.js";
import { addCommentCommand } from "../src/work-commands.js";
import { createProviderSessionCommand } from "../src/work-records.js";
import { LAUNCH_NOW, launchFixture, success } from "./launch-fixture.js";

const migrationDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations/d1",
);
const migration = "0038_agent_work_authority";
const databases: Database.Database[] = [];

function database() {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  databases.push(raw);
  return raw;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(LAUNCH_NOW));
});
afterEach(() => {
  for (const raw of databases.splice(0)) raw.close();
  vi.useRealTimers();
});

async function fixture(previous = false) {
  const raw = database();
  const migrationResult = applyMigrationsForVerification(
    raw,
    migrationDirectory,
    previous ? { stopBeforeId: migration } : {},
  );
  if (previous) expect(migrationResult.head).toBe("0037_artifact_version_retained");
  const f = await launchFixture(adaptBetterSqlite3(raw));
  const claimed = await f.claim();
  success(
    await f.native(authorizeLaunchCommand, {
      principal: f.principal,
      authorization: claimed.final,
    }),
  );
  // Synthetic relational fixture only; native capture is proven by the A01 runtime harness.
  raw
    .prepare("UPDATE run_executions SET state = 'attached' WHERE id = ?")
    .run(claimed.final.run_execution_id);
  const reference: AgentWorkRequest = {
    schema_version: 1,
    run_execution_id: claimed.final.run_execution_id,
    assignment_generation: claimed.final.assignment_generation,
    request_id: "migration-binding",
  };
  async function bind() {
    return success(
      await f.hub.execute(bindAgentSessionCommand, {
        workspaceId: FIX.workspace,
        actorRunnerId: f.runner,
        authorizationEpoch: 1,
        idempotencyKey: agentWorkKey("session-bind", reference),
        input: {
          principal: f.principal,
          request: {
            reference,
            observation: {
              provider: "fake",
              observed_session_id: "synthetic-session",
              observed_at: LAUNCH_NOW,
            },
          },
        },
      }),
    );
  }
  async function comment() {
    const bound = await bind();
    const request = { ...reference, request_id: "migration-comment" };
    return success(
      await f.hub.execute(agentRunCommentCommand, {
        workspaceId: FIX.workspace,
        actorRunnerId: f.runner,
        authorizationEpoch: 1,
        idempotencyKey: agentWorkKey("comment", request),
        input: {
          principal: f.principal,
          request: {
            reference: request,
            binding: bound.binding,
            body: "Synthetic agent comment",
          },
        },
      }),
    );
  }
  return { ...f, ...claimed, raw, bind, comment };
}

type FixtureTable =
  "run_executions" | "execution_assignments" | "execution_session_bindings" | "agent_work_effects";
function insert(raw: Database.Database, table: FixtureTable, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  return raw
    .prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
    .run(...keys.map((key) => row[key]));
}
function row(raw: Database.Database, table: FixtureTable) {
  return raw.prepare(`SELECT * FROM ${table} LIMIT 1`).get() as Record<string, unknown>;
}

function nextBinding(raw: Database.Database, generation: number) {
  const executionId = randomUlid();
  insert(raw, "run_executions", {
    ...row(raw, "run_executions"),
    id: executionId,
    state: "ended",
    end_reason: "process_exit",
    ended_at: LAUNCH_NOW,
  });
  insert(raw, "execution_assignments", {
    ...row(raw, "execution_assignments"),
    execution_id: executionId,
    assignment_generation: generation,
  });
  return {
    ...row(raw, "execution_session_bindings"),
    execution_id: executionId,
    assignment_generation: generation,
  };
}

describe("agent-work migration relationships", () => {
  it("upgrades populated immediate previous head without rewriting legacy records", async () => {
    const f = await fixture(true);
    success(
      await f.human(addCommentCommand, {
        taskId: f.task.id,
        body: "Synthetic legacy human comment",
        kind: "discussion",
      }),
    );
    const session = success(
      await f.human(createProviderSessionCommand, {
        runId: f.claimed.specification.run_id,
        executionId: f.final.run_execution_id,
        provider: "fake",
        requestedSessionId: "synthetic-requested-only",
      }),
    );
    const preservedTables = ["tasks", "comments", "provider_sessions", "execution_assignments"];
    const before = preservedTables.map((table) => f.raw.prepare(`SELECT * FROM ${table}`).all());
    expect(applyMigrationsForVerification(f.raw, migrationDirectory).head).toBe(migration);
    expect(preservedTables.map((table) => f.raw.prepare(`SELECT * FROM ${table}`).all())).toEqual(
      before,
    );
    expect(f.raw.prepare("SELECT COUNT(*) AS count FROM execution_session_bindings").get()).toEqual(
      { count: 0 },
    );
    expect(f.raw.prepare("SELECT COUNT(*) AS count FROM agent_work_effects").get()).toEqual({
      count: 0,
    });
    const fresh = database();
    applyMigrationsForVerification(fresh, migrationDirectory);
    expect(schemaSnapshot(f.raw)).toEqual(schemaSnapshot(fresh));
    expect(f.raw.pragma("foreign_key_check")).toEqual([]);
    expect((await f.bind()).binding.provider_session_id).toBe(session.id);
    expect(
      f.raw
        .prepare(
          "SELECT requested_session_id, observed_session_id FROM provider_sessions WHERE id = ?",
        )
        .get(session.id),
    ).toEqual({
      requested_session_id: "synthetic-requested-only",
      observed_session_id: "synthetic-session",
    });
  });

  it("allows multiple execution associations without replacing the session origin", async () => {
    const f = await fixture();
    const bound = await f.bind();
    for (const generation of [2, 3]) {
      insert(f.raw, "execution_session_bindings", nextBinding(f.raw, generation));
    }
    expect(
      f.raw
        .prepare(
          "SELECT COUNT(*) AS count, COUNT(DISTINCT provider_session_id) AS sessions FROM execution_session_bindings",
        )
        .get(),
    ).toEqual({ count: 3, sessions: 1 });
    expect(
      f.raw
        .prepare("SELECT execution_id FROM provider_sessions WHERE id = ?")
        .get(bound.binding.provider_session_id),
    ).toEqual({ execution_id: f.final.run_execution_id });
    expect(f.raw.pragma("foreign_key_check")).toEqual([]);
  });

  it.each([
    "workspace_id",
    "run_id",
    "project_id",
    "source_task_id",
    "runner_id",
    "provider_session_id",
    "observed_session_id",
  ])("rejects a binding with mismatched %s", async (field) => {
    const f = await fixture();
    await f.bind();
    const binding = nextBinding(f.raw, 2);
    // All parent identities are valid before changing the single field under test.
    expect(() =>
      insert(f.raw, "execution_session_bindings", {
        ...binding,
        [field]: randomUlid(),
      }),
    ).toThrow(/FOREIGN KEY/);
  });

  it("keeps binding/effect rows immutable and comment authorship noncontradictory", async () => {
    const f = await fixture();
    const comment = await f.comment();
    for (const table of ["execution_session_bindings", "agent_work_effects"] as const) {
      expect(() => f.raw.prepare(`UPDATE ${table} SET workspace_id = workspace_id`).run()).toThrow(
        /immutable/,
      );
      expect(() => f.raw.prepare(`DELETE FROM ${table}`).run()).toThrow(/immutable/);
    }
    expect(() =>
      f.raw
        .prepare("UPDATE comments SET author_human_id = ? WHERE id = ?")
        .run(FIX.owner, comment.id),
    ).toThrow(/provenance|author/);
    expect(() =>
      f.raw.prepare("UPDATE comments SET kind = 'progress' WHERE id = ?").run(comment.id),
    ).toThrow(/provenance|author/);
    expect(
      f.raw.prepare("SELECT created_by_human_id FROM tasks WHERE id = ?").get(f.task.id),
    ).toEqual({ created_by_human_id: FIX.owner });
  });

  it("retains unique historical revision attribution after later task changes", async () => {
    const f = await fixture();
    await f.comment();
    const effect = {
      ...row(f.raw, "agent_work_effects"),
      operation_key: `agent:${"a".repeat(64)}`,
      kind: "task.update",
      comment_id: null,
      resulting_task_version: 2,
    };
    insert(f.raw, "agent_work_effects", effect);
    f.raw.prepare("UPDATE tasks SET resource_version = 3 WHERE id = ?").run(f.task.id);
    expect(f.raw.pragma("foreign_key_check")).toEqual([]);
    expect(() =>
      insert(f.raw, "agent_work_effects", { ...effect, operation_key: `agent:${"b".repeat(64)}` }),
    ).toThrow(/UNIQUE/);
    expect(() =>
      insert(f.raw, "agent_work_effects", {
        ...effect,
        resulting_task_version: 3,
        operation_key: `agent:a${"z".repeat(63)}`,
      }),
    ).toThrow(/CHECK/);
    expect(() =>
      insert(f.raw, "agent_work_effects", {
        ...effect,
        resulting_task_version: 3,
        operation_key: `agent:${"b".repeat(64)}`,
        target_task_id: randomUlid(),
      }),
    ).toThrow(/CHECK|FOREIGN KEY/);
  });
});

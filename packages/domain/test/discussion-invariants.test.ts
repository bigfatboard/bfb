// ABOUTME: Tests discussion byte bounds, immutable causal records and exact-session ownership backstops.
// ABOUTME: Exercises human-decision authority and rejection atomicity without claiming real provider execution.

import { describe, expect, it } from "vitest";
import type { DiscussionChangeRequest } from "@bfb/protocol";
import { FIX } from "../src/fixtures.js";
import { randomUlid } from "../src/ids.js";
import { addContextCommand } from "../src/work-commands.js";
import { changeDiscussionCommand, createDiscussionCommand } from "../src/discussions.js";
import { changeDiscussionTurnCommand } from "../src/discussion-turns.js";
import { readParticipantDiscussion } from "../src/discussion-views.js";
import { discussionFixture, SYNTHETIC_OUTPUT } from "./discussion-fixture.js";
import { LAUNCH_NOW, success } from "./launch-fixture.js";

function change(
  id: string,
  version: number,
  action: DiscussionChangeRequest["action"],
  extra: object = {},
) {
  return {
    schema_version: 1,
    idempotency_key: randomUlid(),
    discussion_id: id,
    expected_version: version,
    action,
    ...extra,
  } as DiscussionChangeRequest;
}

describe("discussion persisted invariants", () => {
  it("supports the maximum C08 context count and rejects additions without widening the frozen brief", async () => {
    const f = await discussionFixture();
    for (let item = 2; item < 64; item++)
      success(
        await f.human(addContextCommand, {
          taskId: f.task.id,
          kind: "constraint",
          audience: "agent",
          body: `Synthetic bounded context ${item}`,
        }),
      );
    expect(
      await f.human(addContextCommand, {
        taskId: f.task.id,
        kind: "constraint",
        audience: "agent",
        body: "Synthetic context overflow",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "context_limit_reached" },
    });
    const created = await f.create();
    const view = await readParticipantDiscussion(
      {
        db: f.db,
        workspaceId: FIX.workspace,
        actorSystemId: created.run_ids![0]!,
        authorizationEpoch: 1,
        now: LAUNCH_NOW,
      },
      created.discussion_id,
    );
    expect(view.brief.context).toHaveLength(63);
    expect(JSON.stringify(view)).not.toContain("Synthetic context overflow");
  });

  it("enforces shared-brief UTF-8 bytes instead of only string character count", async () => {
    const f = await discussionFixture();
    for (let item = 0; item < 2; item++)
      success(
        await f.human(addContextCommand, {
          taskId: f.task.id,
          kind: "constraint",
          audience: "agent",
          body: "界".repeat(12_000),
        }),
      );
    expect(await f.human(createDiscussionCommand, f.input)).toMatchObject({
      ok: false,
      error: { code: "bound_exceeded" },
    });
    expect(await f.db.prepare("SELECT COUNT(*) AS count FROM discussions").get()).toEqual({
      count: 0,
    });
  });

  it("keeps oversized Unicode intervention, output and decision rejections atomic", async () => {
    const f = await discussionFixture(),
      created = await f.create(),
      id = created.discussion_id;
    expect(
      await f.human(
        changeDiscussionCommand,
        change(id, 1, "intervene", { text: "界".repeat(3000) }),
      ),
    ).toMatchObject({ ok: false, error: { code: "bound_exceeded" } });
    expect((await f.row(id)).resource_version).toBe(1);
    await f.phase(id, 1, "accept");
    await f.phase(id, 1, "dispatch");
    const participant = (await f.participants(id))[0]!,
      session = await f.session(participant);
    await f.phase(id, 1, "acknowledge", { session_id: session });
    const before = await f.row(id);
    expect(
      await f.run(
        changeDiscussionTurnCommand,
        participant.run_id,
        await f.turnInput(id, 1, "complete", {
          session_id: session,
          output: {
            ...SYNTHETIC_OUTPUT,
            reasons: Array.from({ length: 3 }, () => "界".repeat(1024)),
          },
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "bound_exceeded" } });
    expect(await f.row(id)).toEqual(before);
    expect(await f.db.prepare("SELECT COUNT(*) AS count FROM discussion_messages").get()).toEqual({
      count: 0,
    });
    const cancelled = success(
      await f.human(changeDiscussionCommand, change(id, before.resource_version, "cancel")),
    );
    expect(
      await f.human(
        changeDiscussionCommand,
        change(id, cancelled.version, "decide", {
          decision: {
            kind: "needs_more_context",
            summary: "界".repeat(3000),
            recommendation_ids: [],
          },
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "bound_exceeded" } });
    expect((await f.row(id)).resource_version).toBe(cancelled.version);
    expect(await f.db.prepare("SELECT COUNT(*) AS count FROM discussion_decisions").get()).toEqual({
      count: 0,
    });
  });

  it("rejects a replacement logical session even when it claims the same observed provider identity", async () => {
    const f = await discussionFixture(),
      created = await f.create(),
      id = created.discussion_id;
    await f.complete(id, 1);
    await f.complete(id, 2);
    await f.phase(id, 3, "accept");
    await f.phase(id, 3, "dispatch");
    const participant = (await f.participants(id))[0]!,
      replacement = randomUlid();
    // Synthetic trusted-runtime fault: a new logical session claims an already bound provider identity.
    await f.db
      .prepare(
        `INSERT INTO provider_sessions (workspace_id, id, run_id, execution_id, provider, observed_session_id, state, resource_version, started_at)
      SELECT workspace_id, ?, run_id, execution_id, provider, observed_session_id, state, 1, started_at FROM provider_sessions WHERE workspace_id = ? AND run_id = ?`,
      )
      .run(replacement, FIX.workspace, participant.run_id);
    const before = await f.row(id);
    expect(
      await f.run(
        changeDiscussionTurnCommand,
        participant.run_id,
        await f.turnInput(id, 3, "acknowledge", { session_id: replacement }),
      ),
    ).toMatchObject({ ok: false, error: { code: "session_mismatch" } });
    expect(await f.row(id)).toEqual(before);
    expect(
      await f.db
        .prepare(
          "SELECT COUNT(*) AS count FROM discussion_session_bindings WHERE participant_id = ?",
        )
        .get(participant.id),
    ).toEqual({ count: 1 });
  });

  it("backs observed-session ownership with a durable uniqueness constraint across discussions", async () => {
    const f = await discussionFixture(),
      first = await f.create(),
      second = await f.create({ idempotency_key: randomUlid() });
    for (const id of [first.discussion_id, second.discussion_id]) {
      await f.phase(id, 1, "accept");
      await f.phase(id, 1, "dispatch");
      const participant = (await f.participants(id))[0]!,
        session = await f.session(participant, "synthetic-duplicate-observed-session");
      const before = await f.row(id);
      const outcome = await f.run(
        changeDiscussionTurnCommand,
        participant.run_id,
        await f.turnInput(id, 1, "acknowledge", { session_id: session }),
      );
      if (id === first.discussion_id) success(outcome);
      else {
        expect(outcome).toMatchObject({ ok: false });
        expect(await f.row(id)).toEqual(before);
      }
    }
    expect(
      await f.db.prepare("SELECT COUNT(*) AS count FROM discussion_session_bindings").get(),
    ).toEqual({ count: 1 });
  });

  it("rejects edits and deletion of every immutable identity and completed record", async () => {
    const f = await discussionFixture(),
      created = await f.create({ rounds: 1 }),
      id = created.discussion_id;
    await f.complete(id, 1);
    await f.complete(id, 2);
    const concluded = success(
      await f.human(
        changeDiscussionCommand,
        change(id, (await f.row(id)).resource_version, "conclude"),
      ),
    );
    success(
      await f.human(
        changeDiscussionCommand,
        change(id, concluded.version, "decide", {
          decision: {
            kind: "needs_more_context",
            summary: "Synthetic immutable decision",
            recommendation_ids: [],
          },
        }),
      ),
    );
    for (const [table, assignment] of [
      ["discussions", "brief_json = '{}'"],
      ["discussion_participants", "slot = 1 - slot"],
      ["discussion_turns", "ordinal = 6"],
      ["discussion_deliveries", "source_message_ids_json = '[\"synthetic\"]'"],
      ["discussion_session_bindings", "observed_session_id = 'synthetic-forgery'"],
      ["discussion_messages", "body_json = '{}'"],
      ["discussion_conclusions", "recommendation_ids_json = '[]'"],
      ["discussion_decisions", "body_json = '{}'"],
      ["discussion_command_receipts", "result_json = '{}'"],
    ]) {
      await expect(f.db.prepare(`UPDATE ${table} SET ${assignment}`).run()).rejects.toThrow();
      await expect(f.db.prepare(`DELETE FROM ${table}`).run()).rejects.toThrow(/immutable/);
    }
    await expect(
      f.db.prepare("UPDATE runs SET purpose = 'work' WHERE purpose = 'discussion'").run(),
    ).rejects.toThrow(/immutable/);
    await expect(
      f.db.prepare("UPDATE runs SET result_state = 'accepted' WHERE purpose = 'discussion'").run(),
    ).rejects.toThrow(/cannot submit or accept/);
    expect(await f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("requires an attributed recommendation for human decisions and excludes decisions from participant views", async () => {
    const f = await discussionFixture(),
      created = await f.create(),
      id = created.discussion_id;
    const intervention = success(
      await f.human(
        changeDiscussionCommand,
        change(id, 1, "intervene", { text: "Synthetic intervention is not a recommendation" }),
      ),
    );
    const message = await f.complete(id, 1);
    const cancelled = success(
      await f.human(
        changeDiscussionCommand,
        change(id, (await f.row(id)).resource_version, "cancel"),
      ),
    );
    for (const refs of [
      [],
      [randomUlid()],
      [intervention.message_id!],
      [message.message_id!, message.message_id!],
    ])
      expect(
        await f.human(
          changeDiscussionCommand,
          change(id, cancelled.version, "decide", {
            decision: {
              kind: "record_recommendation",
              summary: "Synthetic invalid references",
              recommendation_ids: refs,
            },
          }),
        ),
      ).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    const input = change(id, cancelled.version, "decide", {
      decision: {
        kind: "record_recommendation",
        summary: "Synthetic explicit human decision",
        recommendation_ids: [message.message_id!],
      },
    });
    expect(await f.run(changeDiscussionCommand, created.run_ids![0]!, input)).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    const decided = success(await f.human(changeDiscussionCommand, input));
    expect(success(await f.human(changeDiscussionCommand, input))).toEqual(decided);
    const view = await readParticipantDiscussion(
      {
        db: f.db,
        workspaceId: FIX.workspace,
        actorSystemId: created.run_ids![0]!,
        authorizationEpoch: 1,
        now: LAUNCH_NOW,
      },
      id,
    );
    expect(view.decision).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("Synthetic explicit human decision");
    expect(
      await f.db.prepare("SELECT state, resource_version FROM tasks WHERE id = ?").get(f.task.id),
    ).toEqual({ state: "ready", resource_version: 1 });
  });

  it("rejects an unestablished failure reason while permitting truthful context invalidation", async () => {
    const f = await discussionFixture(),
      created = await f.create(),
      id = created.discussion_id,
      run = created.run_ids![0]!;
    await f.phase(id, 1, "accept");
    for (const reason of ["context_changed", "deadline_exceeded"])
      expect(
        await f.run(changeDiscussionTurnCommand, run, await f.turnInput(id, 1, "fail", { reason })),
      ).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    success(
      await f.human(addContextCommand, {
        taskId: f.task.id,
        kind: "constraint",
        audience: "agent",
        body: "Synthetic invalidated context",
      }),
    );
    const failed = await f.phase(id, 1, "fail", { reason: "context_changed" });
    expect(failed.state).toBe("failed");
    expect((await f.row(id)).reason).toBe("context_changed");
    expect(
      await f.db
        .prepare("SELECT DISTINCT result_state FROM runs WHERE purpose = 'discussion'")
        .all(),
    ).toEqual([{ result_state: "failed" }]);
  });
});

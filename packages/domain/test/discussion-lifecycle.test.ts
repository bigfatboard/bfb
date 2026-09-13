// ABOUTME: Exercises frozen participant views, exact-session binding and bounded discussion failure paths.
// ABOUTME: Keeps authorization loss, deadline, input ambiguity and human decisions distinct from provider or task completion.

import { describe, expect, it } from "vitest";
import type { DiscussionChangeRequest } from "@bfb/protocol";

import { loadPrincipal } from "../src/authorization.js";
import { FIX } from "../src/fixtures.js";
import { randomUlid } from "../src/ids.js";
import { changeDiscussionCommand, concludeDiscussionCommand } from "../src/discussions.js";
import { changeDiscussionTurnCommand } from "../src/discussion-turns.js";
import {
  listTaskDiscussions,
  readHumanDiscussion,
  readParticipantDiscussion,
} from "../src/discussion-views.js";
import { addContextCommand } from "../src/work-commands.js";
import { buildProjectLanes } from "../src/projections.js";
import { discussionFixture, HUMAN_ONLY_CANARY, SYNTHETIC_OUTPUT } from "./discussion-fixture.js";
import { LAUNCH_NOW, success } from "./launch-fixture.js";

function input(
  id: string,
  version: number,
  action: DiscussionChangeRequest["action"],
  extra: Record<string, unknown> = {},
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

describe("discussion causal lifecycle", () => {
  it("withholds same-round peer answers and freezes later interventions outside already accepted input", async () => {
    const f = await discussionFixture(),
      created = await f.create(),
      id = created.discussion_id;
    const [first, second] = await f.participants(id);
    const context = (run: string) => ({
      db: f.db,
      workspaceId: FIX.workspace,
      actorSystemId: run,
      authorizationEpoch: 1,
      now: LAUNCH_NOW,
    });
    const firstMessage = await f.complete(id, 1);
    expect((await readParticipantDiscussion(context(second!.run_id), id)).messages).toHaveLength(0);
    await f.phase(id, 2, "accept");
    success(
      await f.human(
        changeDiscussionCommand,
        input(id, (await f.row(id)).resource_version, "intervene", {
          text: "Synthetic next-turn context",
        }),
      ),
    );
    const stillFrozen = await readParticipantDiscussion(context(second!.run_id), id);
    expect(stillFrozen.messages).toHaveLength(0);
    expect(stillFrozen.turns[0]!.delivery?.source_message_ids).toEqual([]);
    await f.phase(id, 2, "dispatch");
    const session = await f.session(second!);
    await f.phase(id, 2, "acknowledge", { session_id: session });
    const secondMessage = await f.phase(id, 2, "complete", {
      session_id: session,
      output: SYNTHETIC_OUTPUT,
    });
    const next = await readParticipantDiscussion(context(first!.run_id), id);
    expect(next.messages.map((message) => message.id)).toEqual(
      expect.arrayContaining([firstMessage.message_id, secondMessage.message_id]),
    );
    expect(next.messages).toHaveLength(3);
    expect(next.scope).toBe("participant");
    expect(JSON.stringify(next)).not.toContain(HUMAN_ONLY_CANARY);
    expect(next.turns).toHaveLength(3);
    await f.phase(id, 3, "accept");
    expect(
      (await readParticipantDiscussion(context(first!.run_id), id)).turns[1]!.delivery
        ?.source_message_ids,
    ).toHaveLength(3);
  });

  it("surfaces agent-visible context changes without changing the frozen brief or substituting live context", async () => {
    const f = await discussionFixture(),
      created = await f.create(),
      id = created.discussion_id;
    const before = await f.row(id),
      principal = await loadPrincipal(f.db, FIX.workspace, FIX.owner);
    success(
      await f.human(addContextCommand, {
        taskId: f.task.id,
        kind: "note",
        audience: "human",
        body: "Another synthetic private note",
      }),
    );
    expect(
      (await readHumanDiscussion(f.db, principal, id, LAUNCH_NOW)).dispatch_block_reason,
    ).toBeUndefined();
    success(
      await f.human(addContextCommand, {
        taskId: f.task.id,
        kind: "constraint",
        audience: "agent",
        body: "Synthetic changed boundary",
      }),
    );
    const view = await readHumanDiscussion(f.db, principal, id, LAUNCH_NOW);
    expect(view.dispatch_block_reason).toBe("context_changed");
    expect(JSON.stringify(view.brief)).not.toContain("Synthetic changed boundary");
    const request = await f.turnInput(id, 1, "accept");
    expect(await f.run(changeDiscussionTurnCommand, created.run_ids![0]!, request)).toMatchObject({
      ok: false,
      error: { code: "context_changed" },
    });
    expect((await f.row(id)).brief_json).toBe(before.brief_json);
    expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM discussion_deliveries`).get()).toEqual(
      { count: 0 },
    );
  });

  it("denies foreign, wrong-participant and normal-run reads and delivery attempts", async () => {
    const f = await discussionFixture(),
      created = await f.create(),
      id = created.discussion_id;
    const first = created.run_ids![0]!,
      second = created.run_ids![1]!;
    const request = await f.turnInput(id, 1, "accept");
    expect(await f.run(changeDiscussionTurnCommand, second, request)).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(await f.run(changeDiscussionTurnCommand, randomUlid(), request)).toMatchObject({
      ok: false,
    });
    const context = {
      db: f.db,
      workspaceId: FIX.workspace,
      actorSystemId: first,
      authorizationEpoch: 1,
      now: LAUNCH_NOW,
    };
    await expect(
      readParticipantDiscussion({ ...context, workspaceId: randomUlid() }, id),
    ).rejects.toThrow(/not found/);
    const other = await f.create({ idempotency_key: randomUlid() });
    await expect(readParticipantDiscussion(context, other.discussion_id)).rejects.toThrow(
      /not authorized/,
    );
    expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM discussion_deliveries`).get()).toEqual(
      { count: 0 },
    );
  });

  it("rechecks sponsor epoch before participant reads, mutations and durable receipt replay", async () => {
    const f = await discussionFixture(),
      created = await f.create(),
      id = created.discussion_id,
      run = created.run_ids![0]!;
    const request = await f.turnInput(id, 1, "accept");
    success(await f.run(changeDiscussionTurnCommand, run, request));
    await f.db
      .prepare(
        `UPDATE workspace_members SET authorization_epoch = 2 WHERE workspace_id = ? AND human_id = ?`,
      )
      .run(FIX.workspace, FIX.owner);
    await f.db
      .prepare(
        `UPDATE workspace_authorization_epochs SET authorization_epoch = 2 WHERE workspace_id = ? AND human_id = ?`,
      )
      .run(FIX.workspace, FIX.owner);
    expect(await f.run(changeDiscussionTurnCommand, run, request)).toMatchObject({
      ok: false,
      error: { code: "stale_authorization" },
    });
    await expect(
      readParticipantDiscussion(
        {
          db: f.db,
          workspaceId: FIX.workspace,
          actorSystemId: run,
          authorizationEpoch: 1,
          now: LAUNCH_NOW,
        },
        id,
      ),
    ).rejects.toThrow(/epoch/);
    const current = await loadPrincipal(f.db, FIX.workspace, FIX.owner);
    expect((await readHumanDiscussion(f.db, current, id, LAUNCH_NOW)).dispatch_block_reason).toBe(
      "sponsor_revoked",
    );
    expect((await f.row(id)).resource_version).toBe(2);
  });

  it("allows one next-turn acceptance and one delivery under competing workers and duplicate dispatch", async () => {
    const f = await discussionFixture(),
      created = await f.create(),
      id = created.discussion_id,
      run = created.run_ids![0]!;
    const request = await f.turnInput(id, 1, "accept");
    const raced = await Promise.all(
      [request, { ...request, idempotency_key: randomUlid() }].map((input) =>
        f.run(changeDiscussionTurnCommand, run, input),
      ),
    );
    expect(raced.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(
      raced.filter((outcome) => !outcome.ok && outcome.error.code === "stale_version"),
    ).toHaveLength(1);
    const early = await f.turnInput(id, 2, "accept");
    expect(await f.run(changeDiscussionTurnCommand, created.run_ids![1]!, early)).toMatchObject({
      ok: false,
      error: { code: "invalid_transition" },
    });
    const dispatch = await f.turnInput(id, 1, "dispatch");
    const first = success(await f.run(changeDiscussionTurnCommand, run, dispatch));
    expect(success(await f.run(changeDiscussionTurnCommand, run, dispatch))).toEqual(first);
    expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM discussion_deliveries`).get()).toEqual(
      { count: 1 },
    );
  });

  it("rejects requested-only, wrong-run and changed observed session identities", async () => {
    const f = await discussionFixture(),
      created = await f.create(),
      id = created.discussion_id;
    const [participant, peer] = await f.participants(id);
    await f.phase(id, 1, "accept");
    await f.phase(id, 1, "dispatch");
    const wrong = await f.session(peer!);
    expect(
      await f.run(
        changeDiscussionTurnCommand,
        participant!.run_id,
        await f.turnInput(id, 1, "acknowledge", { session_id: wrong }),
      ),
    ).toMatchObject({ ok: false, error: { code: "session_mismatch" } });
    const session = await f.session(participant!, "synthetic-observed-first");
    await f.db
      .prepare(
        `UPDATE provider_sessions SET requested_session_id = observed_session_id, observed_session_id = NULL WHERE workspace_id = ? AND id = ?`,
      )
      .run(FIX.workspace, session);
    expect(
      await f.run(
        changeDiscussionTurnCommand,
        participant!.run_id,
        await f.turnInput(id, 1, "acknowledge", { session_id: session }),
      ),
    ).toMatchObject({ ok: false, error: { code: "session_mismatch" } });
    await f.db
      .prepare(
        `UPDATE provider_sessions SET observed_session_id = 'synthetic-observed-first' WHERE workspace_id = ? AND id = ?`,
      )
      .run(FIX.workspace, session);
    await f.phase(id, 1, "acknowledge", { session_id: session });
    await f.db
      .prepare(
        `UPDATE provider_sessions SET observed_session_id = 'synthetic-observed-replacement' WHERE workspace_id = ? AND id = ?`,
      )
      .run(FIX.workspace, session);
    expect(
      await f.run(
        changeDiscussionTurnCommand,
        participant!.run_id,
        await f.turnInput(id, 1, "complete", { session_id: session, output: SYNTHETIC_OUTPUT }),
      ),
    ).toMatchObject({ ok: false, error: { code: "session_mismatch" } });
    expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM discussion_messages`).get()).toEqual({
      count: 0,
    });
  });

  it("pauses after a possible unacknowledged effect and never blindly dispatches again", async () => {
    const f = await discussionFixture(),
      created = await f.create(),
      id = created.discussion_id,
      run = created.run_ids![0]!;
    await f.phase(id, 1, "accept");
    await f.phase(id, 1, "dispatch");
    const request = await f.turnInput(id, 1, "ambiguous");
    const paused = success(await f.run(changeDiscussionTurnCommand, run, request));
    expect(paused.state).toBe("paused");
    expect(success(await f.run(changeDiscussionTurnCommand, run, request))).toEqual(paused);
    expect(
      await f.run(changeDiscussionTurnCommand, run, await f.turnInput(id, 1, "dispatch")),
    ).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
    expect((await f.row(id)).reason).toBe("delivery_ambiguous");
    expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM discussion_messages`).get()).toEqual({
      count: 0,
    });
  });

  it("rejects effects at the deadline but permits a verified terminal failure record without task changes", async () => {
    const f = await discussionFixture(),
      created = await f.create({ duration_seconds: 60 }),
      id = created.discussion_id,
      run = created.run_ids![0]!;
    const before = await f.db
      .prepare(`SELECT * FROM tasks WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, f.task.id);
    await f.phase(id, 1, "accept");
    const now = "2026-09-12T12:01:00.000Z";
    expect(
      await f.run(changeDiscussionTurnCommand, run, await f.turnInput(id, 1, "dispatch"), now),
    ).toMatchObject({ ok: false, error: { code: "deadline_exceeded" } });
    const failure = await f.turnInput(id, 1, "fail", { reason: "deadline_exceeded" });
    const failed = success(await f.run(changeDiscussionTurnCommand, run, failure, now));
    expect(failed.state).toBe("failed");
    expect(success(await f.run(changeDiscussionTurnCommand, run, failure, now))).toEqual(failed);
    expect(
      await f.db
        .prepare(`SELECT * FROM tasks WHERE workspace_id = ? AND id = ?`)
        .get(FIX.workspace, f.task.id),
    ).toEqual(before);
    expect(await f.db.prepare(`SELECT state FROM discussion_deliveries`).get()).toEqual({
      state: "failed",
    });
  });

  it("bounds human interventions and rejects private, traversing and wrong-revision evidence", async () => {
    const f = await discussionFixture(),
      created = await f.create(),
      id = created.discussion_id,
      run = created.run_ids![0]!;
    for (let index = 0; index < 12; index++)
      success(
        await f.human(
          changeDiscussionCommand,
          input(id, (await f.row(id)).resource_version, "intervene", {
            text: `Synthetic clarification ${index}`,
          }),
        ),
      );
    expect(
      await f.human(
        changeDiscussionCommand,
        input(id, (await f.row(id)).resource_version, "intervene", { text: "Synthetic overflow" }),
      ),
    ).toMatchObject({ ok: false, error: { code: "bound_exceeded" } });
    await f.phase(id, 1, "accept");
    await f.phase(id, 1, "dispatch");
    const session = await f.session((await f.participants(id))[0]!);
    await f.phase(id, 1, "acknowledge", { session_id: session });
    for (const evidence of [
      { kind: "context", context_id: randomUlid(), explanation: "Not frozen context" },
      {
        kind: "repository",
        repository_path: "../private",
        git_revision: f.input.git_revision,
        explanation: "Traversal",
      },
      {
        kind: "repository",
        repository_path: "src/main.ts",
        git_revision: "b".repeat(40),
        explanation: "Changed revision",
      },
    ])
      expect(
        await f.run(
          changeDiscussionTurnCommand,
          run,
          await f.turnInput(id, 1, "complete", {
            session_id: session,
            output: { ...SYNTHETIC_OUTPUT, evidence: [evidence] },
          }),
        ),
      ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const output = {
      ...SYNTHETIC_OUTPUT,
      evidence: [
        {
          kind: "repository",
          repository_path: "src/main.ts",
          git_revision: f.input.git_revision,
          line: 1,
          explanation: "Synthetic frozen-revision reference",
        },
      ],
    };
    expect(
      (await f.phase(id, 1, "complete", { session_id: session, output })).message_id,
    ).toBeDefined();
  });

  it("concludes only after all six intentional turns and leaves ordinary board work unstarted", async () => {
    const f = await discussionFixture(),
      created = await f.create(),
      id = created.discussion_id,
      run = created.run_ids![0]!;
    expect(await f.run(concludeDiscussionCommand, run, input(id, 1, "conclude"))).toMatchObject({
      ok: false,
      error: { code: "invalid_transition" },
    });
    for (let ordinal = 1; ordinal <= 6; ordinal++) await f.complete(id, ordinal);
    expect((await f.row(id)).state).toBe("active");
    const concluded = success(
      await f.run(
        concludeDiscussionCommand,
        run,
        input(id, (await f.row(id)).resource_version, "conclude"),
      ),
    );
    expect(concluded.state).toBe("concluded");
    const principal = await loadPrincipal(f.db, FIX.workspace, FIX.owner);
    const view = await readHumanDiscussion(f.db, principal, id, LAUNCH_NOW);
    expect(view.conclusion?.recommendation_ids).toHaveLength(2);
    expect(view.messages).toHaveLength(6);
    expect(view.decision).toBeUndefined();
    const task = (await buildProjectLanes(f.db, FIX.workspace, [FIX.projectA]))
      .flatMap((lane) => lane.tasks)
      .find((task) => task.id === f.task.id);
    expect(task?.runSummary).toBeUndefined();
    expect((await listTaskDiscussions(f.db, principal, f.task.id)).discussions).toHaveLength(1);
  });
});

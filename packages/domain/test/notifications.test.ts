// ABOUTME: Proves X01 event selection, delivery identity, deep links, preferences, and fan-out guards.
// ABOUTME: Fixtures are synthetic; every suppression kind below names a real registered hub command.

import { describe, expect, it } from "vitest";

import { FIX } from "../src/fixtures.js";
import { randomUlid, syntheticUlid, isUlid } from "../src/ids.js";
import {
  buildPushPayload,
  defaultPreference,
  deriveDeliveryId,
  fanoutNotificationEvent,
  getPreferenceOverrides,
  loadPushAttempt,
  NOTIFICATION_COPY,
  notificationDeepLink,
  notificationJobId,
  purgeRevokedNotificationState,
  recordDeliveryOutcome,
  registerPushEndpointCommand,
  removePushEndpointCommand,
  resolvePreference,
  selectNotificationEvent,
  setNotificationPreferenceCommand,
  type NotificationCategory,
  type PreferenceOverride,
} from "../src/notifications.js";
import { requestAttentionCommand } from "../src/attention.js";
import { removeMemberCommand } from "../src/workspace-authorization.js";
import { launchFixture, LAUNCH_NOW, success } from "./launch-fixture.js";

const ATTENTION_ID = syntheticUlid("X01ATTN");
const LAUNCH_ID = syntheticUlid("X01LAUNCH");
const RUN_ID = syntheticUlid("X01RUN");

function payload(result: unknown, input: unknown = {}): unknown {
  return { actor: {}, input, result };
}

describe("notification event selection", () => {
  it("selects an open attention request", () => {
    const selected = selectNotificationEvent(
      "attention.request",
      payload({ id: ATTENTION_ID, state: "open" }),
    );
    expect(selected).toEqual({ category: "attention", attentionId: ATTENTION_ID });
  });

  it("ignores answered attention and malformed payloads", () => {
    expect(selectNotificationEvent("attention.request", payload({ id: ATTENTION_ID, state: "answered" }))).toBeNull();
    expect(selectNotificationEvent("attention.request", payload({ state: "open" }))).toBeNull();
    expect(selectNotificationEvent("attention.request", payload({ id: "nope", state: "open" }))).toBeNull();
    expect(selectNotificationEvent("attention.request", null)).toBeNull();
    expect(selectNotificationEvent("attention.request", { nope: true })).toBeNull();
  });

  it("selects launch blocked and expired outcomes only", () => {
    expect(
      selectNotificationEvent("launch.reject", payload({ state: "rejected" }, { launchId: LAUNCH_ID })),
    ).toEqual({ category: "launch_blocked", launchId: LAUNCH_ID });
    expect(
      selectNotificationEvent("launch.reject", payload({ state: "expired" }, { launchId: LAUNCH_ID })),
    ).toEqual({ category: "launch_blocked", launchId: LAUNCH_ID });
    expect(
      selectNotificationEvent(
        "launch.claim",
        payload({ state: "rejected", reason: "launch_blocked" }, { launchId: LAUNCH_ID }),
      ),
    ).toEqual({ category: "launch_blocked", launchId: LAUNCH_ID });
    expect(
      selectNotificationEvent(
        "launch.claim",
        payload({ state: "expired", reason: "launch_expired" }, { launchId: LAUNCH_ID }),
      ),
    ).toEqual({ category: "launch_blocked", launchId: LAUNCH_ID });
    expect(
      selectNotificationEvent(
        "launch.authorize",
        payload({
          launch_id: LAUNCH_ID,
          decision: "rejected",
          rejection: { code: "launch_expired" },
        }),
      ),
    ).toEqual({ category: "launch_blocked", launchId: LAUNCH_ID });
    expect(
      selectNotificationEvent(
        "launch.claim",
        payload({ state: "claimed", claim: {} }, { launchId: LAUNCH_ID }),
      ),
    ).toBeNull();
    expect(
      selectNotificationEvent(
        "launch.claim",
        payload({ state: "rejected" }, { launchId: LAUNCH_ID }),
      ),
    ).toBeNull();
    expect(
      selectNotificationEvent(
        "launch.authorize",
        payload({ launch_id: LAUNCH_ID, decision: "authorized" }),
      ),
    ).toBeNull();
    expect(selectNotificationEvent("launch.reject", payload({ state: "rejected" }, {}))).toBeNull();
  });

  it("selects each retained result transition", () => {
    expect(
      selectNotificationEvent(
        "result.submit",
        payload({
          submission: { id: randomUlid(), run_id: RUN_ID, version: 2 },
          runResultState: "submitted",
          taskState: "review",
        }),
      ),
    ).toEqual({ category: "result_submitted", runId: RUN_ID, submissionVersion: 2 });
    expect(
      selectNotificationEvent(
        "result.request_changes",
        payload({ runResultState: "changes_requested" }, { runId: RUN_ID }),
      ),
    ).toEqual({ category: "result_changes_requested", runId: RUN_ID });
    expect(
      selectNotificationEvent(
        "result.accept",
        payload({ runResultState: "accepted" }, { runId: RUN_ID }),
      ),
    ).toEqual({ category: "result_accepted", runId: RUN_ID });
    expect(
      selectNotificationEvent("result.fail", payload({ runResultState: "failed" }, { runId: RUN_ID })),
    ).toEqual({ category: "run_failed", runId: RUN_ID });
    expect(
      selectNotificationEvent(
        "result.cancel",
        payload({ runResultState: "cancelled" }, { runId: RUN_ID }),
      ),
    ).toEqual({ category: "run_cancelled", runId: RUN_ID });
    expect(
      selectNotificationEvent(
        "result.submit",
        payload({
          submission: { id: randomUlid(), run_id: RUN_ID, version: 1 },
          runResultState: "submitted",
          taskState: "active",
        }),
      ),
    ).toBeNull();
    expect(
      selectNotificationEvent("result.accept", payload({ runResultState: "accepted" }, {})),
    ).toBeNull();
    expect(
      selectNotificationEvent("result.fail", payload({ runResultState: "submitted" }, { runId: RUN_ID })),
    ).toBeNull();
  });

  it("suppresses every other registered hub command kind", () => {
    const silent = [
      "event.ingest",
      "task.create",
      "task.update",
      "task.dependency.add",
      "task.link.add",
      "comment.add",
      "progress.report",
      "context.add",
      "context.deliver.delegation",
      "context.deliver.run",
      "run.create",
      "run.activity.update",
      "execution.create",
      "execution.transition",
      "provider_session.create",
      "launch.start",
      "launch.reconcile",
      "launch.tighten",
      "launch.wake.issue",
      "launch.wake.redeem",
      "checkout.lease.observe",
      "run_control.create",
      "run_control.claim",
      "run_control.acknowledge",
      "runner.connection.touch",
      "runner.inventory.replace",
      "runner.enroll",
      "runner.grants.replace",
      "runner.revoke",
      "runner.challenge.issue",
      "runner.token.exchange",
      "runner.request.authenticate",
      "cli.authorize_device",
      "cli.exchange_credential",
      "cli.revoke_binding",
      "artifact.create_version",
      "artifact.issue_grant",
      "artifact.finalize_version",
      "artifact.mark_failed",
      "attention.answer",
      "attention.resolve",
      "discussion.create",
      "discussion.change",
      "discussion.conclude",
      "discussion.turn",
      "agent_profile.create",
      "agent_profile.update",
      "project.create",
      "project.update",
      "project.access.change",
      "project.policy.update",
      "repository.config.report",
      "workspace.policy.update",
      "workspace.invitation.create",
      "workspace.member.remove",
      "workspace.member.role.change",
      "notification.preference.set",
      "notification.push_endpoint.register",
      "notification.push_endpoint.remove",
    ];
    for (const kind of silent) {
      expect(selectNotificationEvent(kind, payload({ ok: true })), kind).toBeNull();
      expect(
        selectNotificationEvent(kind, payload({ state: "open", id: ATTENTION_ID })),
        kind,
      ).toBeNull();
    }
    expect(selectNotificationEvent("no.such.command", payload({}))).toBeNull();
  });
});

describe("notification delivery identity", () => {
  it("is stable per event channel recipient and ULID-shaped", () => {
    const first = deriveDeliveryId(FIX.workspace, 42, "browser_push", FIX.owner);
    expect(first).toEqual(deriveDeliveryId(FIX.workspace, 42, "browser_push", FIX.owner));
    expect(isUlid(first)).toBe(true);
    expect(deriveDeliveryId(FIX.workspace, 42, "macos", FIX.owner)).not.toBe(first);
    expect(deriveDeliveryId(FIX.workspace, 43, "browser_push", FIX.owner)).not.toBe(first);
    expect(deriveDeliveryId(FIX.workspace, 42, "browser_push", FIX.member)).not.toBe(first);
    expect(notificationJobId(FIX.workspace, 42)).toBe(`x01:${FIX.workspace}:42`);
  });
});

describe("notification deep links and copy", () => {
  const canaries = [
    "SYNTHETIC task text with /local/secret/path",
    "ghp_syntheticcanarytoken",
    "bfb __launch --evil",
    "--provider-arg=canary",
  ];
  const subject = {
    projectId: FIX.projectA,
    taskId: syntheticUlid("X01TASK"),
    runId: RUN_ID,
    attentionId: ATTENTION_ID,
    submissionVersion: 3,
  };

  it("builds ID-only links per category", () => {
    const origin = "https://bfb.example.test";
    const attention = notificationDeepLink(origin, FIX.workspace, subject, "attention");
    expect(attention).toBe(
      `${origin}/w/${FIX.workspace}/tasks/${subject.taskId}/attention/${ATTENTION_ID}`,
    );
    const review = notificationDeepLink(origin, FIX.workspace, subject, "result_submitted");
    expect(review).toBe(
      `${origin}/w/${FIX.workspace}/tasks/${subject.taskId}/runs/${RUN_ID}/results/3`,
    );
    const blocked = notificationDeepLink(origin, FIX.workspace, subject, "launch_blocked");
    expect(blocked).toBe(`${origin}/w/${FIX.workspace}/tasks/${subject.taskId}/runs/${RUN_ID}`);
    for (const link of [attention, review, blocked]) {
      expect(link).toMatch(/^https:\/\/[a-z0-9.:-]+\/w\/[0-9A-Z]{26}\/tasks\/[0-9A-Z]{26}/);
      for (const canary of canaries) {
        expect(link).not.toContain(canary);
      }
    }
  });

  it("keeps fixed copy and payloads free of task text", () => {
    for (const category of Object.keys(NOTIFICATION_COPY) as NotificationCategory[]) {
      const copy = NOTIFICATION_COPY[category];
      for (const canary of canaries) {
        expect(copy.title).not.toContain(canary);
        expect(copy.body).not.toContain(canary);
      }
      const body = buildPushPayload({
        appOrigin: "https://bfb.example.test",
        workspaceId: FIX.workspace,
        subject,
        category,
        deliveryId: syntheticUlid("X01DLV"),
        eventCursor: 7,
      });
      const encoded = JSON.stringify(body);
      for (const canary of canaries) {
        expect(encoded).not.toContain(canary);
      }
      expect(body.delivery_id).toBe(syntheticUlid("X01DLV"));
      expect(body.event_cursor).toBe(7);
    }
  });
});

describe("notification preference defaults", () => {
  it("stays sparse with project-over-workspace precedence", () => {
    expect(defaultPreference("attention")).toBe(true);
    expect(defaultPreference("launch_blocked")).toBe(true);
    expect(defaultPreference("run_failed")).toBe(true);
    expect(defaultPreference("result_submitted")).toBe(true);
    expect(defaultPreference("result_accepted")).toBe(true);
    expect(defaultPreference("result_changes_requested")).toBe(false);
    expect(defaultPreference("run_cancelled")).toBe(false);
    const overrides: PreferenceOverride[] = [
      { project_id: "*", channel: "browser_push", category: "attention", enabled: false },
      { project_id: FIX.projectA, channel: "browser_push", category: "attention", enabled: true },
    ];
    expect(resolvePreference(overrides, FIX.projectA, "browser_push", "attention")).toBe(true);
    expect(resolvePreference(overrides, FIX.projectB, "browser_push", "attention")).toBe(false);
    expect(resolvePreference([], FIX.projectA, "macos", "run_cancelled")).toBe(false);
  });
});

describe("notification preference and endpoint commands", () => {
  it("stores overrides, validates scope, and manages endpoints", async () => {
    const f = await launchFixture();
    const stored = success(
      await f.human(setNotificationPreferenceCommand, {
        projectId: FIX.projectA,
        channel: "macos",
        category: "run_cancelled",
        enabled: true,
      }),
    );
    expect(stored.project_id).toBe(FIX.projectA);
    const overrides = await getPreferenceOverrides(f.db, FIX.workspace, FIX.owner);
    expect(
      overrides.find(
        (entry) => entry.channel === "macos" && entry.category === "run_cancelled",
      )?.enabled,
    ).toBe(true);
    const foreign = await f.human(
      setNotificationPreferenceCommand,
      { projectId: FIX.projectB, channel: "macos", category: "attention", enabled: true },
      LAUNCH_NOW,
      FIX.reviewer,
    );
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe("not_found");

    const registered = success(
      await f.human(registerPushEndpointCommand, {
        endpoint: "https://push.synthetic.test/x01-endpoint",
        p256dh: "B".repeat(87),
        auth: "A".repeat(22),
      }),
    );
    expect(registered.endpoint_hash).toMatch(/^[0-9a-f]{64}$/);
    const bad = await f.human(registerPushEndpointCommand, {
      endpoint: "http://push.synthetic.test/plain",
      p256dh: "B".repeat(87),
      auth: "A".repeat(22),
    });
    expect(bad.ok).toBe(false);
    const removed = success(
      await f.human(removePushEndpointCommand, { endpointHash: registered.endpoint_hash }),
    );
    expect(removed.removed).toBe(true);
    const missing = success(
      await f.human(removePushEndpointCommand, { endpointHash: registered.endpoint_hash }),
    );
    expect(missing.removed).toBe(false);
  });
});

describe("notification fan-out guards", () => {
  it("fans out once, then suppresses opted-out and revoked readers", async () => {
    const f = await launchFixture();
    const { claimed } = await f.claim();
    const requested = success(
      await f.native(requestAttentionCommand, {
        principal: f.principal,
        runId: claimed.specification.run_id,
        executionId: claimed.specification.run_execution_id,
        assignmentGeneration: claimed.specification.assignment_generation,
        kind: "clarification",
        question: "Synthetic X01 fan-out question",
        blocking: true,
      }),
    );
    expect(requested.state).toBe("open");
    success(
      await f.human(registerPushEndpointCommand, {
        endpoint: "https://push.synthetic.test/x01-owner",
        p256dh: "B".repeat(87),
        auth: "A".repeat(22),
      }),
    );
    const cursorRow = (await f.db
      .prepare(
        `SELECT workspace_cursor FROM semantic_events
         WHERE workspace_id = ? AND kind = 'attention.request' ORDER BY workspace_cursor DESC LIMIT 1`,
      )
      .get(FIX.workspace)) as { workspace_cursor: number };
    const first = await fanoutNotificationEvent(f.db, {
      workspaceId: FIX.workspace,
      eventCursor: cursorRow.workspace_cursor,
      eventKind: "attention.request",
      now: LAUNCH_NOW,
    });
    expect(first.status).toBe("notified");
    expect(first.push).toBe(1);
    expect(first.macos).toBe(1);
    const repeat = await fanoutNotificationEvent(f.db, {
      workspaceId: FIX.workspace,
      eventCursor: cursorRow.workspace_cursor,
      eventKind: "attention.request",
      now: LAUNCH_NOW,
    });
    expect(repeat.status).toBe("notified");
    const rows = (await f.db
      .prepare(
        `SELECT COUNT(*) AS count FROM notification_deliveries WHERE workspace_id = ? AND event_cursor = ?`,
      )
      .get(FIX.workspace, cursorRow.workspace_cursor)) as { count: number };
    expect(rows.count).toBe(2);

    const deliveries = (await f.db
      .prepare(
        `SELECT delivery_id, channel FROM notification_deliveries
         WHERE workspace_id = ? AND event_cursor = ? ORDER BY delivery_id`,
      )
      .all(FIX.workspace, cursorRow.workspace_cursor)) as Array<{
      delivery_id: string;
      channel: string;
    }>;
    const pushRow = deliveries.find((entry) => entry.channel === "browser_push");
    expect(pushRow).toBeDefined();
    const loaded = await loadPushAttempt(f.db, {
      workspaceId: FIX.workspace,
      deliveryId: pushRow!.delivery_id,
    });
    expect(loaded.ok).toBe(true);

    success(
      await f.human(setNotificationPreferenceCommand, {
        channel: "browser_push",
        category: "attention",
        enabled: false,
      }),
    );
    const optedOut = await loadPushAttempt(f.db, {
      workspaceId: FIX.workspace,
      deliveryId: pushRow!.delivery_id,
    });
    expect(optedOut.ok).toBe(false);
    if (!optedOut.ok) expect(optedOut.outcome).toMatchObject({ terminal: true, state: "suppressed" });

    await recordDeliveryOutcome(f.db, {
      workspaceId: FIX.workspace,
      deliveryId: pushRow!.delivery_id,
      outcome: { terminal: false, code: "push_status_503" },
      now: LAUNCH_NOW,
    });
    const counted = (await f.db
      .prepare(
        `SELECT attempt_count, state, last_error FROM notification_deliveries
         WHERE workspace_id = ? AND delivery_id = ?`,
      )
      .get(FIX.workspace, pushRow!.delivery_id)) as {
      attempt_count: number;
      state: string;
      last_error: string;
    };
    expect(counted.attempt_count).toBe(1);
    expect(counted.state).toBe("pending");
    expect(counted.last_error).toContain("push_status_503");
  });

  it("purges endpoints and preferences of removed members", async () => {
    const f = await launchFixture();
    success(
      await f.human(
        registerPushEndpointCommand,
        {
          endpoint: "https://push.synthetic.test/x01-member",
          p256dh: "B".repeat(87),
          auth: "A".repeat(22),
        },
        LAUNCH_NOW,
        FIX.member,
      ),
    );
    success(
      await f.human(
        setNotificationPreferenceCommand,
        { channel: "macos", category: "attention", enabled: false },
        LAUNCH_NOW,
        FIX.member,
      ),
    );
    const before = await purgeRevokedNotificationState(f.db, FIX.workspace);
    expect(before).toEqual({ endpoints: 0, preferences: 0 });
    success(await f.human(removeMemberCommand, { humanId: FIX.member }));
    const purged = await purgeRevokedNotificationState(f.db, FIX.workspace);
    expect(purged).toEqual({ endpoints: 1, preferences: 1 });
    const attempt = await loadPushAttempt(f.db, {
      workspaceId: FIX.workspace,
      deliveryId: `0${"1".repeat(25)}`,
    });
    expect(attempt.ok).toBe(false);
  });
});

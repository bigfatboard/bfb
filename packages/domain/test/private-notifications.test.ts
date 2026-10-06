// ABOUTME: Proves fail-closed notification lineage through fanout, historical pages and native delivery.
// ABOUTME: Synthetic private policies and SQL interleaves distinguish current authority from earlier snapshots.

import type { SqlDatabase } from "@bfb/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerAttentionCommand, requestAttentionCommand } from "../src/attention.js";
import { FIX } from "../src/fixtures.js";
import { randomUlid } from "../src/ids.js";
import {
  ackMacosNotifications,
  deriveDeliveryId,
  fanoutNotificationEvent,
  listDeliveries,
  loadPushAttempt,
  pullMacosNotifications,
  registerPushEndpointCommand,
} from "../src/notifications.js";
import { captureFixture } from "./agent-capture-fixture.js";
import { LAUNCH_NOW, success } from "./launch-fixture.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(LAUNCH_NOW);
});
afterEach(() => vi.useRealTimers());
const access = (humanId = FIX.owner, authorizationEpoch = 1) => ({
  workspaceId: FIX.workspace,
  humanId,
  authorizationEpoch,
});
async function privacy(db: SqlDatabase, taskId: string) {
  await db
    .prepare(
      "INSERT INTO task_privacy (workspace_id, task_id, owner_human_id, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(FIX.workspace, taskId, FIX.member, LAUNCH_NOW);
}
async function fixture() {
  const f = await captureFixture(undefined, false, false, {
    taskCreatorHumanId: FIX.member,
    requestingHumanId: FIX.owner,
  });
  const attention = success(
    await f.native(requestAttentionCommand, {
      principal: f.principal,
      request: {
        ...f.bound(),
        kind: "clarification",
        question: "SYNTHETIC_PRIVATE_NOTIFICATION_QUESTION",
        blocking: true,
      },
    }),
  );
  const row = (await f.db
    .prepare(
      "SELECT workspace_cursor FROM semantic_events WHERE workspace_id = ? AND kind = 'attention.request' ORDER BY workspace_cursor DESC LIMIT 1",
    )
    .get(FIX.workspace)) as { workspace_cursor: number };
  success(
    await f.human(registerPushEndpointCommand, {
      endpoint: "https://push.synthetic.test/private-fence",
      p256dh: "B".repeat(87),
      auth: "A".repeat(22),
    }),
  );
  const input = {
    workspaceId: FIX.workspace,
    eventCursor: row.workspace_cursor,
    eventKind: "attention.request",
    now: LAUNCH_NOW,
  };
  const pushId = deriveDeliveryId(FIX.workspace, row.workspace_cursor, "browser_push", FIX.owner);
  const macosId = deriveDeliveryId(FIX.workspace, row.workspace_cursor, "macos", f.runner);
  return { ...f, attention, input, pushId, macosId };
}
function before(db: SqlDatabase, match: RegExp, change: () => Promise<void>): SqlDatabase {
  let fired = false;
  return {
    ...db,
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!match.test(sql)) return statement;
      const invoke = async () => {
        if (!fired) {
          fired = true;
          await change();
        }
      };
      return {
        ...statement,
        async get(...params) {
          await invoke();
          return statement.get(...params);
        },
        async all(...params) {
          await invoke();
          return statement.all(...params);
        },
        async run(...params) {
          await invoke();
          return statement.run(...params);
        },
      };
    },
  };
}

describe("private notification fences", () => {
  it("retains enabled project override precedence over disabled workspace preference", async () => {
    const f = await fixture();
    for (const [scope, enabled] of [
      ["*", 0],
      [FIX.projectA, 1],
    ] as const) {
      await f.db
        .prepare(
          `INSERT INTO notification_preferences
        (workspace_id,human_id,project_id,channel,category,enabled,updated_at)
        VALUES (?,?,?,'browser_push','attention',?,?)`,
        )
        .run(FIX.workspace, FIX.owner, scope, enabled, LAUNCH_NOW);
    }
    await fanoutNotificationEvent(f.db, f.input);
    expect(
      await loadPushAttempt(f.db, { workspaceId: FIX.workspace, deliveryId: f.pushId }),
    ).toMatchObject({ ok: true });
  });
  it.each([FIX.projectA, "*"])(
    "checks current %s opt-out in the final endpoint selection",
    async (scope) => {
      const f = await fixture();
      await fanoutNotificationEvent(f.db, f.input);
      const db = before(
        f.db,
        /SELECT endpoint_hash, endpoint, p256dh, auth FROM notification_push_endpoints/,
        async () => {
          await f.db
            .prepare(
              `INSERT INTO notification_preferences
        (workspace_id,human_id,project_id,channel,category,enabled,updated_at)
        VALUES (?,?,?,'browser_push','attention',0,?)`,
            )
            .run(FIX.workspace, FIX.owner, scope, LAUNCH_NOW);
        },
      );
      expect(
        await loadPushAttempt(db, { workspaceId: FIX.workspace, deliveryId: f.pushId }),
      ).toMatchObject({ ok: false });
    },
  );
  it("creates no recipient delivery for private attention even with creator/grant access", async () => {
    const f = await fixture();
    await privacy(f.db, f.task.id);
    await f.db
      .prepare(
        "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'read',?)",
      )
      .run(FIX.workspace, randomUlid(), f.task.id, FIX.owner, LAUNCH_NOW);
    expect(await fanoutNotificationEvent(f.db, f.input)).toEqual({ status: "subject_gone" });
    expect(await f.db.prepare("SELECT delivery_id FROM notification_deliveries").all()).toEqual([]);
  });
  it("preserves answered shared attention history and native pull", async () => {
    const f = await fixture();
    await fanoutNotificationEvent(f.db, f.input);
    success(
      await f.human(answerAttentionCommand, {
        attentionId: f.attention.id,
        expectedVersion: 1,
        answer: "Synthetic answer",
      }),
    );
    expect(
      (await listDeliveries(f.db, FIX.workspace, FIX.owner, 100, access())).map(
        (row) => row.delivery_id,
      ),
    ).toContain(f.pushId);
    expect((await pullMacosNotifications(f.db, f.principal, LAUNCH_NOW)).deliveries).toEqual([
      { delivery_id: f.macosId },
    ]);
  });
  it("excludes private history and retry, and hidden native acknowledgement is identical to missing", async () => {
    const f = await fixture();
    await fanoutNotificationEvent(f.db, f.input);
    await privacy(f.db, f.task.id);
    expect(await listDeliveries(f.db, FIX.workspace, FIX.owner, 100, access())).toEqual([]);
    expect(
      await loadPushAttempt(f.db, { workspaceId: FIX.workspace, deliveryId: f.pushId }),
    ).toMatchObject({ ok: false });
    expect((await pullMacosNotifications(f.db, f.principal, LAUNCH_NOW)).deliveries).toEqual([]);
    expect(await ackMacosNotifications(f.db, f.principal, [f.macosId], LAUNCH_NOW)).toEqual(
      await ackMacosNotifications(f.db, f.principal, [randomUlid()], LAUNCH_NOW),
    );
    expect(
      await f.db
        .prepare("SELECT acked_at FROM notification_macos_inbox WHERE delivery_id = ?")
        .get(f.macosId),
    ).toEqual({ acked_at: null });
  });
  it("filters inaccessible rows before history and native limits", async () => {
    const f = await fixture();
    await fanoutNotificationEvent(f.db, f.input);
    const second = success(
      await f.native(requestAttentionCommand, {
        principal: f.principal,
        request: {
          ...f.bound(),
          kind: "clarification",
          question: "Synthetic second shared attention",
          blocking: false,
        },
      }),
    );
    const cursor = (await f.db
      .prepare(
        "SELECT workspace_cursor FROM semantic_events WHERE kind = 'attention.request' ORDER BY workspace_cursor DESC LIMIT 1",
      )
      .get()) as { workspace_cursor: number };
    await fanoutNotificationEvent(f.db, { ...f.input, eventCursor: cursor.workspace_cursor });
    // Make only the newer delivery's lineage invalid, retaining the historical row.
    await f.db
      .prepare("UPDATE attention_requests SET project_id = ? WHERE id = ?")
      .run(FIX.projectB, second.id);
    expect(
      (await listDeliveries(f.db, FIX.workspace, FIX.owner, 1, access())).map(
        (row) => row.delivery_id,
      ),
    ).toHaveLength(1);
    expect(
      (await listDeliveries(f.db, FIX.workspace, FIX.owner, 1, access()))[0]?.event_cursor,
    ).toBe(f.input.eventCursor);
    await f.db
      .prepare(
        "UPDATE notification_macos_inbox SET created_at = '2020-01-01T00:00:00.000Z' WHERE delivery_id <> ?",
      )
      .run(f.macosId);
    expect((await pullMacosNotifications(f.db, f.principal, LAUNCH_NOW, 1)).deliveries).toEqual([
      { delivery_id: f.macosId },
    ]);
  });
  it("rechecks task policy at delivery insertion", async () => {
    const f = await fixture();
    const db = before(f.db, /INSERT(?: OR IGNORE)? INTO notification_deliveries/, () =>
      privacy(f.db, f.task.id),
    );
    await fanoutNotificationEvent(db, f.input);
    expect(await f.db.prepare("SELECT delivery_id FROM notification_deliveries").all()).toEqual([]);
  });
  it("rechecks recipient epoch at delivery insertion", async () => {
    const f = await fixture();
    const db = before(f.db, /INSERT(?: OR IGNORE)? INTO notification_deliveries/, async () => {
      await f.db
        .prepare(
          "UPDATE workspace_authorization_epochs SET authorization_epoch = 2 WHERE human_id = ?",
        )
        .run(FIX.owner);
      await f.db
        .prepare("UPDATE workspace_members SET authorization_epoch = 2 WHERE human_id = ?")
        .run(FIX.owner);
    });
    await fanoutNotificationEvent(db, f.input);
    expect(
      await f.db
        .prepare("SELECT delivery_id FROM notification_deliveries WHERE human_id = ?")
        .all(FIX.owner),
    ).toEqual([]);
  });
  it.each(["pull", "ack"])(
    "checks runner token revocation in actual native %s query",
    async (operation) => {
      const f = await fixture();
      await fanoutNotificationEvent(f.db, f.input);
      const db = before(
        f.db,
        operation === "pull"
          ? /FROM notification_macos_inbox AS inbox/
          : /UPDATE notification_macos_inbox SET acked_at/,
        async () => {
          await f.db
            .prepare("UPDATE runner_tokens SET revoked_at = ? WHERE id = ?")
            .run(LAUNCH_NOW, f.principal.tokenId);
        },
      );
      if (operation === "pull")
        expect((await pullMacosNotifications(db, f.principal, LAUNCH_NOW)).deliveries).toEqual([]);
      else
        expect(await ackMacosNotifications(db, f.principal, [f.macosId], LAUNCH_NOW)).toEqual({
          schema_version: 1,
          acked: 0,
        });
    },
  );
  it("retains a wide runner project ceiling without exceeding D1's 100 bindings", async () => {
    const f = await fixture();
    await fanoutNotificationEvent(f.db, f.input);
    for (let index = 0; index < 105; index++) {
      const projectId = randomUlid();
      await f.db
        .prepare(
          "INSERT INTO projects (workspace_id,id,name,slug,tint,access_mode,created_at) VALUES (?,?,?,?,'#3B82F6','workspace',?)",
        )
        .run(
          FIX.workspace,
          projectId,
          `Synthetic notification project ${index}`,
          `notification-${index}`,
          LAUNCH_NOW,
        );
      await f.db
        .prepare(
          "INSERT INTO runner_project_grants (workspace_id,runner_id,project_id) VALUES (?,?,?)",
        )
        .run(FIX.workspace, f.runner, projectId);
      f.principal.projectIds.push(projectId);
    }
    const db: SqlDatabase = {
      ...f.db,
      prepare(sql) {
        const statement = f.db.prepare(sql);
        return {
          ...statement,
          async get(...parameters) {
            expect(parameters.length).toBeLessThanOrEqual(100);
            return statement.get(...parameters);
          },
          async all(...parameters) {
            expect(parameters.length).toBeLessThanOrEqual(100);
            return statement.all(...parameters);
          },
        };
      },
    };
    expect((await pullMacosNotifications(db, f.principal, LAUNCH_NOW)).deliveries).toEqual([
      { delivery_id: f.macosId },
    ]);
  });
  it("rechecks policy in the endpoint SELECT after preference/preflight reads", async () => {
    const f = await fixture();
    await fanoutNotificationEvent(f.db, f.input);
    const db = before(
      f.db,
      /SELECT endpoint_hash, endpoint, p256dh, auth FROM notification_push_endpoints/,
      () => privacy(f.db, f.task.id),
    );
    expect(
      await loadPushAttempt(db, { workspaceId: FIX.workspace, deliveryId: f.pushId }),
    ).toMatchObject({ ok: false });
  });
  it("pins historical browser recipient epoch in the actual history SELECT", async () => {
    const f = await fixture();
    await fanoutNotificationEvent(f.db, f.input);
    const db = before(f.db, /FROM notification_deliveries/, async () => {
      await f.db
        .prepare(
          "UPDATE workspace_authorization_epochs SET authorization_epoch = 2 WHERE human_id = ?",
        )
        .run(FIX.owner);
      await f.db
        .prepare("UPDATE workspace_members SET authorization_epoch = 2 WHERE human_id = ?")
        .run(FIX.owner);
    });
    expect(await listDeliveries(db, FIX.workspace, FIX.owner, 1, access())).toEqual([]);
  });
});

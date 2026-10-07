// ABOUTME: Proves notification recipients receive stable random aliases instead of internal ledger identities.
// ABOUTME: Uses genuine shared attention fanout and retained runner authority to test public delivery boundaries.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { adaptBetterSqlite3, listMigrationFiles, type SqlDatabase } from "@bfb/db";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { requestAttentionCommand } from "../src/attention.js";
import { FIX } from "../src/fixtures.js";
import { randomUlid } from "../src/ids.js";
import {
  createNotificationPublicId,
  ensureNotificationPublicIdsCommand,
  listNotificationIdentityCandidates,
  NOTIFICATION_IDENTITY_SYSTEM_ID,
} from "../src/notification-identities.js";
import {
  ackMacosNotifications,
  buildPushPayload,
  deriveDeliveryId,
  fanoutNotificationEvent,
  listDeliveries,
  pullMacosNotifications,
  registerPushEndpointCommand,
} from "../src/notifications.js";
import { captureFixture } from "./agent-capture-fixture.js";
import { LAUNCH_NOW, success } from "./launch-fixture.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(LAUNCH_NOW);
});
afterEach(() => vi.useRealTimers());

const access = {
  workspaceId: FIX.workspace,
  humanId: FIX.owner,
  authorizationEpoch: 1,
};
const migrations = listMigrationFiles(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../migrations/d1"),
);
const identityMigrationIndex = migrations.findIndex(
  (migration) => migration.id === "0046_notification_public_identities",
);
if (identityMigrationIndex < 0) throw new Error("notification identity migration is missing");
const identityMigration = migrations[identityMigrationIndex]!;
const unavailable = {
  code: "request_rejected",
  message: "notification identities are unavailable",
};

async function fixture(legacy = false, deliver = true) {
  let raw: Database.Database | null = null;
  let database: SqlDatabase | undefined;
  if (legacy) {
    raw = new Database(":memory:");
    raw.pragma("foreign_keys = ON");
    for (const migration of migrations.slice(0, identityMigrationIndex)) raw.exec(migration.sql);
    database = adaptBetterSqlite3(raw);
  }
  const f = await captureFixture(database, false, false, {
    taskCreatorHumanId: FIX.member,
    requestingHumanId: FIX.owner,
  });
  const attention = success(
    await f.native(requestAttentionCommand, {
      principal: f.principal,
      request: {
        ...f.bound(),
        kind: "clarification",
        question: "Synthetic notification identity question",
        blocking: true,
      },
    }),
  );
  const event = (await f.db
    .prepare(
      `SELECT workspace_cursor FROM semantic_events
       WHERE workspace_id = ? AND kind = 'attention.request'
       ORDER BY workspace_cursor DESC LIMIT 1`,
    )
    .get(FIX.workspace)) as { workspace_cursor: number };
  success(
    await f.human(registerPushEndpointCommand, {
      endpoint: "https://push.synthetic.test/notification-identities",
      p256dh: "B".repeat(87),
      auth: "A".repeat(22),
    }),
  );
  const input = {
    workspaceId: FIX.workspace,
    eventCursor: event.workspace_cursor,
    eventKind: "attention.request",
    now: LAUNCH_NOW,
  };
  const pushId = deriveDeliveryId(FIX.workspace, input.eventCursor, "browser_push", FIX.owner);
  const macosId = deriveDeliveryId(FIX.workspace, input.eventCursor, "macos", f.runner);
  if (raw) {
    // Genuine pre-0046 tuples: only migration/application repair adds an alias.
    for (const [id, channel, runner, state] of [
      [pushId, "browser_push", null, "pending"],
      [macosId, "macos", f.runner, "delivered"],
    ] as const) {
      await f.db
        .prepare(
          `INSERT INTO notification_deliveries
        (workspace_id,delivery_id,channel,human_id,runner_id,event_cursor,event_kind,category,state,attempt_count,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'attention.request','attention',?,0,?,?)`,
        )
        .run(
          FIX.workspace,
          id,
          channel,
          FIX.owner,
          runner,
          input.eventCursor,
          state,
          LAUNCH_NOW,
          LAUNCH_NOW,
        );
    }
    await f.db
      .prepare(
        `INSERT INTO notification_macos_inbox (workspace_id,runner_id,delivery_id,created_at)
      VALUES (?,?,?,?)`,
      )
      .run(FIX.workspace, f.runner, macosId, LAUNCH_NOW);
    raw.exec(identityMigration.sql);
  } else if (deliver) await fanoutNotificationEvent(f.db, input);
  const ensure = async (deliveryIds: readonly string[]) => {
    return success(
      await f.hub.execute(ensureNotificationPublicIdsCommand, {
        workspaceId: FIX.workspace,
        idempotencyKey: randomUlid(),
        actorSystemId: NOTIFICATION_IDENTITY_SYSTEM_ID,
        authorizationEpoch: 1,
        input: { deliveryIds: [...deliveryIds] },
      }),
    );
  };
  const callback = async (deliveryIds: readonly string[]) => {
    await ensure(deliveryIds);
  };
  return { ...f, attention, input, pushId, macosId, ensure, callback };
}

describe("notification recipient identities", () => {
  it("omits the raw event position from the fixed push payload", () => {
    const payload = buildPushPayload({
      appOrigin: "https://bfb.synthetic.test",
      workspaceId: FIX.workspace,
      subject: { projectId: FIX.projectA, taskId: FIX.taskAttention },
      category: "attention",
      deliveryId: "00000000000000000000000001",
    });
    expect(Object.keys(payload).sort()).toEqual(["body", "deep_link", "delivery_id", "title"]);
    expect(payload.delivery_id).toBe("00000000000000000000000001");
  });

  it("returns public aliases and no raw position in browser delivery history", async () => {
    const f = await fixture();
    const rows = await listDeliveries(f.db, FIX.workspace, FIX.owner, 100, access);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).not.toHaveProperty("event_cursor");
      expect(row.delivery_id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
      expect([f.pushId, f.macosId]).not.toContain(row.delivery_id);
    }
  });

  it("does not acknowledge the internal native delivery identity", async () => {
    const f = await fixture();
    const pulled = await pullMacosNotifications(f.db, f.principal, LAUNCH_NOW);
    expect(pulled.deliveries).toHaveLength(1);
    expect(pulled.deliveries[0]?.delivery_id).not.toBe(f.macosId);
    expect(await ackMacosNotifications(f.db, f.principal, [f.macosId], LAUNCH_NOW)).toEqual({
      schema_version: 1,
      acked: 0,
    });
    expect(
      await f.db
        .prepare("SELECT acked_at FROM notification_macos_inbox WHERE delivery_id = ?")
        .get(f.macosId),
    ).toEqual({ acked_at: null });
  });

  it("keeps internal retry identity, event association and lifecycle bookkeeping stable", async () => {
    const f = await fixture();
    const before = await f.db
      .prepare("SELECT * FROM notification_deliveries WHERE workspace_id = ? ORDER BY delivery_id")
      .all(FIX.workspace);
    const inbox = await f.db
      .prepare("SELECT * FROM notification_macos_inbox WHERE workspace_id = ?")
      .all(FIX.workspace);
    expect(await fanoutNotificationEvent(f.db, f.input)).toEqual({
      status: "notified",
      category: "attention",
      push: 0,
      macos: 0,
    });
    expect(
      await f.db
        .prepare(
          "SELECT * FROM notification_deliveries WHERE workspace_id = ? ORDER BY delivery_id",
        )
        .all(FIX.workspace),
    ).toEqual(before);
    expect(
      await f.db
        .prepare("SELECT * FROM notification_macos_inbox WHERE workspace_id = ?")
        .all(FIX.workspace),
    ).toEqual(inbox);
  });

  it("uses the full random 128-bit space without Date or Math.random inputs", () => {
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("not cryptographic");
    });
    try {
      const ids = Array.from({ length: 64 }, () => createNotificationPublicId());
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    } finally {
      random.mockRestore();
    }
  });

  it("fails fresh fanout on entropy failure without creating a delivery, then converges on retry", async () => {
    const f = await fixture(false, false);
    vi.mocked(randomBytes).mockImplementationOnce(() => {
      throw new Error("synthetic entropy failure");
    });
    await expect(fanoutNotificationEvent(f.db, f.input)).rejects.toThrow(
      "synthetic entropy failure",
    );
    expect(await f.db.prepare("SELECT delivery_id FROM notification_deliveries").all()).toEqual([]);
    expect(await f.db.prepare("SELECT delivery_id FROM notification_macos_inbox").all()).toEqual(
      [],
    );
    expect(await fanoutNotificationEvent(f.db, f.input)).toMatchObject({ push: 1, macos: 1 });
  });

  it("does not silently discard a fresh recipient on alias collision and retains the winner on retry", async () => {
    const f = await fixture(false, false);
    vi.mocked(randomBytes)
      .mockImplementationOnce((size) => Buffer.alloc(size))
      .mockImplementationOnce((size) => Buffer.alloc(size));
    await expect(fanoutNotificationEvent(f.db, f.input)).rejects.toThrow(/UNIQUE/);
    expect(
      await f.db.prepare("SELECT delivery_id,public_id FROM notification_deliveries").all(),
    ).toEqual([{ delivery_id: f.pushId, public_id: "0".repeat(26) }]);
    expect(await f.db.prepare("SELECT delivery_id FROM notification_macos_inbox").all()).toEqual(
      [],
    );
    expect(await fanoutNotificationEvent(f.db, f.input)).toMatchObject({ push: 0, macos: 1 });
    expect(
      await f.db
        .prepare("SELECT public_id FROM notification_deliveries WHERE delivery_id = ?")
        .get(f.pushId),
    ).toEqual({ public_id: "0".repeat(26) });
  });

  it("rejects invalid public identity before building a push body", () => {
    for (const deliveryId of ["not-an-identity", "0".repeat(26) + "\n"]) {
      expect(() =>
        buildPushPayload({
          appOrigin: "https://bfb.synthetic.test",
          workspaceId: FIX.workspace,
          subject: { projectId: FIX.projectA, taskId: FIX.taskAttention },
          category: "attention",
          deliveryId,
        }),
      ).toThrow("notification identities are unavailable");
    }
  });

  it("repairs populated history once through the registered command without lifecycle changes", async () => {
    const f = await fixture(true);
    const before = await f.db
      .prepare("SELECT * FROM notification_deliveries ORDER BY delivery_id")
      .all();
    const inbox = await f.db.prepare("SELECT * FROM notification_macos_inbox").all();
    expect(await listNotificationIdentityCandidates(f.db, 1)).toHaveLength(1);
    expect(await f.ensure([f.macosId, f.pushId])).toEqual({ selected: 2 });
    expect(await f.ensure([f.pushId, f.macosId])).toEqual({ selected: 0 });
    expect(await listNotificationIdentityCandidates(f.db)).toEqual([]);
    const after = (await f.db
      .prepare("SELECT * FROM notification_deliveries ORDER BY delivery_id")
      .all()) as Array<Record<string, unknown>>;
    expect(after.map((row) => ({ ...row, public_id: null }))).toEqual(before);
    expect(await f.db.prepare("SELECT * FROM notification_macos_inbox").all()).toEqual(inbox);
    expect(await listDeliveries(f.db, FIX.workspace, FIX.owner, 100, access)).toHaveLength(2);
  });

  it("binds cached maintenance to the sorted target set and fixed system actor before cache", async () => {
    const f = await fixture(true);
    const request = {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorSystemId: NOTIFICATION_IDENTITY_SYSTEM_ID,
      authorizationEpoch: 1,
      input: { deliveryIds: [f.pushId, f.macosId] },
    };
    expect(await f.hub.execute(ensureNotificationPublicIdsCommand, request)).toMatchObject({
      ok: true,
      result: { selected: 2 },
      replayed: false,
    });
    expect(
      await f.hub.execute(ensureNotificationPublicIdsCommand, {
        ...request,
        input: { deliveryIds: [f.macosId, f.pushId] },
      }),
    ).toMatchObject({ ok: true, result: { selected: 2 }, replayed: true });
    expect(
      await f.hub.execute(ensureNotificationPublicIdsCommand, {
        ...request,
        authorizationEpoch: 2,
      }),
    ).toMatchObject({ ok: false, error: unavailable });
    expect(await f.human(ensureNotificationPublicIdsCommand, request.input)).toMatchObject({
      ok: false,
      error: unavailable,
    });
    expect(await f.native(ensureNotificationPublicIdsCommand, request.input)).toMatchObject({
      ok: false,
      error: unavailable,
    });
    expect(
      await f.hub.execute(ensureNotificationPublicIdsCommand, {
        ...request,
        actorSystemId: FIX.member,
      }),
    ).toMatchObject({ ok: false, error: unavailable });
    expect(
      await f.hub.execute(ensureNotificationPublicIdsCommand, {
        ...request,
        input: { deliveryIds: [f.pushId] },
      }),
    ).toMatchObject({ ok: false });
    const events = (await f.db
      .prepare(
        "SELECT payload_json FROM semantic_events WHERE kind = 'notification.public_ids.ensure'",
      )
      .all()) as Array<{ payload_json: string }>;
    expect(events).toHaveLength(1);
    const receipt = JSON.parse(events[0]!.payload_json);
    expect(receipt.input).toEqual({ requested: 2 });
    expect(receipt.result).toEqual({ selected: 2 });
  });

  it("rolls back entropy failures and colliding legacy repair aliases with no cached receipt or partial assignment", async () => {
    const f = await fixture(true);
    const request = {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorSystemId: NOTIFICATION_IDENTITY_SYSTEM_ID,
      authorizationEpoch: 1,
      input: { deliveryIds: [f.pushId, f.macosId] },
    };
    vi.mocked(randomBytes).mockImplementationOnce(() => {
      throw new Error("synthetic entropy failure");
    });
    expect(await f.hub.execute(ensureNotificationPublicIdsCommand, request)).toMatchObject({
      ok: false,
      error: { code: "command_failed" },
    });
    expect(await listNotificationIdentityCandidates(f.db)).toHaveLength(2);
    vi.mocked(randomBytes)
      .mockImplementationOnce((size) => Buffer.alloc(size))
      .mockImplementationOnce((size) => Buffer.alloc(size));
    expect(await f.hub.execute(ensureNotificationPublicIdsCommand, request)).toMatchObject({
      ok: false,
      error: { code: "command_failed" },
    });
    expect(await listNotificationIdentityCandidates(f.db)).toHaveLength(2);
    expect(
      await f.db
        .prepare("SELECT idempotency_key FROM idempotency_records WHERE idempotency_key = ?")
        .all(request.idempotencyKey),
    ).toEqual([]);
    expect(
      await f.db
        .prepare(
          "SELECT event_id FROM semantic_events WHERE kind = 'notification.public_ids.ensure'",
        )
        .all(),
    ).toEqual([]);
    expect(await f.hub.execute(ensureNotificationPublicIdsCommand, request)).toMatchObject({
      ok: true,
      result: { selected: 2 },
      replayed: false,
    });
  });

  it("rejects malformed, duplicate and oversized maintenance batches without assigning identities", async () => {
    const f = await fixture(true);
    const inputs: unknown[] = [
      {},
      { deliveryIds: [] },
      { deliveryIds: [f.pushId, f.pushId] },
      { deliveryIds: [f.pushId], extra: true },
      { deliveryIds: ["0000000000000000000000000\u0000"] },
      { deliveryIds: [f.pushId + "\n"] },
      { deliveryIds: Array.from({ length: 101 }, () => randomUlid()) },
    ];
    for (const input of inputs) {
      expect(
        await f.hub.execute(ensureNotificationPublicIdsCommand, {
          workspaceId: FIX.workspace,
          idempotencyKey: randomUlid(),
          actorSystemId: NOTIFICATION_IDENTITY_SYSTEM_ID,
          authorizationEpoch: 1,
          input: input as { deliveryIds: string[] },
        }),
      ).toMatchObject({ ok: false, error: unavailable });
    }
    expect(await listNotificationIdentityCandidates(f.db)).toHaveLength(2);
  });

  it("rejects a visible legacy page without maintenance rather than hiding rows or returning internal IDs", async () => {
    const f = await fixture(true);
    await expect(listDeliveries(f.db, FIX.workspace, FIX.owner, 100, access)).rejects.toMatchObject(
      unavailable,
    );
    await expect(pullMacosNotifications(f.db, f.principal, LAUNCH_NOW)).rejects.toMatchObject(
      unavailable,
    );
  });

  it("ensures a legacy browser page then returns only the same currently authorized aliases", async () => {
    const f = await fixture(true);
    const rows = await listDeliveries(f.db, FIX.workspace, FIX.owner, 100, access, f.callback);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => ![f.pushId, f.macosId].includes(row.delivery_id))).toBe(true);
    expect(await listNotificationIdentityCandidates(f.db)).toEqual([]);
  });

  it("rechecks private parent after awaited repair without delivering the earlier browser page", async () => {
    const f = await fixture(true);
    const callback = async (ids: readonly string[]) => {
      await f.callback(ids);
      await f.db
        .prepare(
          "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
        )
        .run(FIX.workspace, f.task.id, FIX.member, LAUNCH_NOW);
    };
    expect(await listDeliveries(f.db, FIX.workspace, FIX.owner, 100, access, callback)).toEqual([]);
  });

  it("retains the browser credential epoch across repair even if membership is refreshed", async () => {
    const f = await fixture(true);
    const callback = async (ids: readonly string[]) => {
      await f.callback(ids);
      await f.db
        .prepare(
          "UPDATE workspace_authorization_epochs SET authorization_epoch = 2 WHERE human_id = ?",
        )
        .run(FIX.owner);
      await f.db
        .prepare("UPDATE workspace_members SET authorization_epoch = 2 WHERE human_id = ?")
        .run(FIX.owner);
    };
    expect(await listDeliveries(f.db, FIX.workspace, FIX.owner, 100, access, callback)).toEqual([]);
    expect(
      await listDeliveries(f.db, FIX.workspace, FIX.owner, 100, {
        ...access,
        authorizationEpoch: 2,
      }),
    ).toHaveLength(2);
  });

  it("rechecks project access after repair and allows history through a new legitimate credential", async () => {
    const f = await fixture(true);
    const callback = async (ids: readonly string[]) => {
      await f.callback(ids);
      await f.db
        .prepare("UPDATE projects SET access_mode = 'restricted' WHERE id = ?")
        .run(FIX.projectA);
      await f.db
        .prepare("DELETE FROM project_access WHERE human_id = ? AND project_id = ?")
        .run(FIX.owner, FIX.projectA);
    };
    expect(await listDeliveries(f.db, FIX.workspace, FIX.owner, 100, access, callback)).toEqual([]);
  });

  it("repairs native history and acknowledges only its stored public identity", async () => {
    const f = await fixture(true);
    const result = await pullMacosNotifications(f.db, f.principal, LAUNCH_NOW, 25, f.callback);
    expect(result.deliveries).toHaveLength(1);
    const alias = result.deliveries[0]!.delivery_id;
    expect(alias).not.toBe(f.macosId);
    await expect(
      ackMacosNotifications(f.db, f.principal, [alias + "\n"], LAUNCH_NOW),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      ackMacosNotifications(f.db, f.principal, [alias, alias + "\n"], LAUNCH_NOW),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(
      await f.db
        .prepare("SELECT acked_at FROM notification_macos_inbox WHERE delivery_id = ?")
        .get(f.macosId),
    ).toEqual({ acked_at: null });
    await f.ensure([f.pushId]);
    const push = (await f.db
      .prepare("SELECT public_id FROM notification_deliveries WHERE delivery_id = ?")
      .get(f.pushId)) as { public_id: string };
    expect(
      await ackMacosNotifications(
        f.db,
        f.principal,
        [f.macosId, randomUlid(), push.public_id],
        LAUNCH_NOW,
      ),
    ).toEqual({ schema_version: 1, acked: 0 });
    expect(await ackMacosNotifications(f.db, f.principal, [alias], LAUNCH_NOW)).toEqual({
      schema_version: 1,
      acked: 1,
    });
    expect((await pullMacosNotifications(f.db, f.principal, LAUNCH_NOW)).deliveries).toEqual([]);
  });

  it("rechecks runner token and shared parent after native maintenance awaits", async () => {
    const f = await fixture(true);
    const callback = async (ids: readonly string[]) => {
      await f.callback(ids);
      await f.db
        .prepare("UPDATE runner_tokens SET revoked_at = ? WHERE id = ?")
        .run(LAUNCH_NOW, f.principal.tokenId);
    };
    expect(
      (await pullMacosNotifications(f.db, f.principal, LAUNCH_NOW, 25, callback)).deliveries,
    ).toEqual([]);
  });

  it("bounds repeated maintenance interference and normalizes callback errors", async () => {
    const f = await fixture(true);
    const idle = vi.fn(async () => {});
    await expect(
      listDeliveries(f.db, FIX.workspace, FIX.owner, 1, access, idle),
    ).rejects.toMatchObject(unavailable);
    expect(idle).toHaveBeenCalledTimes(3);
    await expect(
      pullMacosNotifications(f.db, f.principal, LAUNCH_NOW, 1, async () => {
        throw new Error("synthetic internal error");
      }),
    ).rejects.toMatchObject(unavailable);
  });

  it("scans all historical states in resumable bounded pages and ignores unknown or foreign targets", async () => {
    const f = await fixture(true);
    await f.db
      .prepare("UPDATE notification_deliveries SET state = 'dead_lettered' WHERE delivery_id = ?")
      .run(f.pushId);
    const candidates = await listNotificationIdentityCandidates(f.db, 1);
    expect(candidates).toHaveLength(1);
    expect(await f.ensure([candidates[0]!.delivery_id, randomUlid()])).toEqual({ selected: 1 });
    expect(await listNotificationIdentityCandidates(f.db)).toHaveLength(1);
    const foreignWorkspace = randomUlid();
    await f.db
      .prepare(
        "INSERT INTO workspaces (id,slug,jurisdiction,created_at) VALUES (?,'notification-other','eu',?)",
      )
      .run(foreignWorkspace, LAUNCH_NOW);
    const foreign = await f.hub.execute(ensureNotificationPublicIdsCommand, {
      workspaceId: foreignWorkspace,
      idempotencyKey: randomUlid(),
      actorSystemId: NOTIFICATION_IDENTITY_SYSTEM_ID,
      authorizationEpoch: 1,
      input: { deliveryIds: [f.pushId, f.macosId] },
    });
    expect(foreign).toMatchObject({ ok: true, result: { selected: 0 } });
    expect(await listNotificationIdentityCandidates(f.db)).toHaveLength(1);
    await expect(listNotificationIdentityCandidates(f.db, 101)).rejects.toMatchObject(unavailable);
  });

  it("permits a shared history role change without binding its alias to the original role", async () => {
    const f = await fixture();
    const before = await listDeliveries(f.db, FIX.workspace, FIX.owner, 100, access);
    await f.db
      .prepare("UPDATE workspace_members SET role = 'owner' WHERE human_id = ?")
      .run(FIX.member);
    await f.db
      .prepare("UPDATE workspace_members SET role = 'reviewer' WHERE human_id = ?")
      .run(FIX.owner);
    expect(await listDeliveries(f.db, FIX.workspace, FIX.owner, 100, access)).toEqual(before);
  });
});

// ABOUTME: Proves bounded Worker notification identity maintenance through registered workspace Hub commands.
// ABOUTME: Synthetic legacy deliveries retain every lifecycle state and inbox reference across repair and retry.

import type { SqlDatabase } from "@bfb/db";
import { FIX } from "@bfb/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LAUNCH_NOW, launchFixture } from "../../../packages/domain/test/launch-fixture.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import {
  ensureNotificationIdentities,
  runNotificationIdentitySweep,
} from "../src/notifications/identities.js";

const STATES = ["pending", "delivered", "suppressed", "failed", "dead_lettered"] as const;
const REJECTED = { code: "request_rejected", message: "request rejected" };
const PUBLIC_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(LAUNCH_NOW);
});
afterEach(() => vi.useRealTimers());

function legacyId(index: number): string {
  return String(index + 1).padStart(26, "0");
}

function boundedDatabase(db: SqlDatabase) {
  const observed = { calls: 0, maximumParameters: 0 };
  function check(params: unknown[]): void {
    observed.calls += 1;
    observed.maximumParameters = Math.max(observed.maximumParameters, params.length);
    if (params.length > 100) throw new Error("synthetic D1 bound: at most 100 parameters");
  }
  function wrap(database: SqlDatabase): SqlDatabase {
    return {
      prepare(sql) {
        const statement = database.prepare(sql);
        return {
          async get(...params) {
            check(params);
            return statement.get(...params);
          },
          async all(...params) {
            check(params);
            return statement.all(...params);
          },
          async run(...params) {
            check(params);
            return statement.run(...params);
          },
        };
      },
      withTransaction: (fn) => database.withTransaction((tx) => fn(wrap(tx))),
    };
  }
  return { db: wrap(db), observed };
}

function countedHub(db: SqlDatabase) {
  const requests: Array<{ commandName: string; request: { input: { deliveryIds: string[] } } }> =
    [];
  const base = createTestWorkspaceHubNamespace(db);
  const namespace = {
    ...base,
    get(id: DurableObjectId) {
      const stub = base.get(id);
      return {
        ...stub,
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          requests.push(JSON.parse(String(init?.body)));
          return stub.fetch(input, init);
        },
      } as DurableObjectStub;
    },
    jurisdiction() {
      return namespace as DurableObjectNamespace;
    },
  } as unknown as DurableObjectNamespace;
  return { namespace, requests };
}

async function fixture(count: number) {
  const f = await launchFixture();
  const ids = Array.from({ length: count }, (_, index) => legacyId(index));
  for (const [index, id] of ids.entries()) {
    const state = STATES[index % STATES.length]!;
    await f.db
      .prepare(
        `INSERT INTO notification_deliveries
         (workspace_id,delivery_id,channel,human_id,runner_id,event_cursor,event_kind,category,
          state,attempt_count,last_error,created_at,updated_at,delivered_at,public_id)
         VALUES (?,?, 'macos',?,?,?,'attention.request','attention',?,?,?,?,?,?,NULL)`,
      )
      .run(
        FIX.workspace,
        id,
        FIX.owner,
        f.runner,
        index + 1,
        state,
        index % 4,
        state === "failed" || state === "dead_lettered" ? "synthetic_delivery_error" : null,
        LAUNCH_NOW,
        LAUNCH_NOW,
        state === "delivered" ? LAUNCH_NOW : null,
      );
    await f.db
      .prepare(
        `INSERT INTO notification_macos_inbox
         (workspace_id,runner_id,delivery_id,created_at,acked_at) VALUES (?,?,?,?,?)`,
      )
      .run(FIX.workspace, f.runner, id, LAUNCH_NOW, index % 2 === 0 ? LAUNCH_NOW : null);
  }
  const bounded = boundedDatabase(f.db);
  const hub = countedHub(bounded.db);
  return { ...f, ids, bounded, ...hub };
}

async function deliveries(db: SqlDatabase) {
  return (await db
    .prepare("SELECT * FROM notification_deliveries ORDER BY workspace_id,delivery_id")
    .all()) as Array<{ delivery_id: string; public_id: string | null; state: string }>;
}

async function inbox(db: SqlDatabase) {
  return db
    .prepare("SELECT * FROM notification_macos_inbox ORDER BY workspace_id,runner_id,delivery_id")
    .all();
}

async function effects(db: SqlDatabase) {
  return Promise.all(
    [
      "idempotency_records",
      "semantic_events",
      "audit_events",
      "outbox_records",
      "workspace_cursors",
    ].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
  );
}

function expectAliases(rows: Awaited<ReturnType<typeof deliveries>>): void {
  expect(
    rows.every((row) => typeof row.public_id === "string" && PUBLIC_ID.test(row.public_id)),
  ).toBe(true);
  expect(new Set(rows.map((row) => row.public_id)).size).toBe(rows.length);
  expect(rows.every((row) => row.public_id !== row.delivery_id)).toBe(true);
}

function expectBatches(requests: ReturnType<typeof countedHub>["requests"], sizes: number[]) {
  expect(requests.map((request) => request.commandName)).toEqual(
    sizes.map(() => "notification.public_ids.ensure"),
  );
  expect(requests.map((request) => request.request.input.deliveryIds.length)).toEqual(sizes);
  expect(requests.every((request) => request.request.input.deliveryIds.length <= 100)).toBe(true);
}

describe("Worker notification identity maintenance", () => {
  it("repairs 100 then 500 deliveries through bounded registered Hub batches without rerun effects", async () => {
    const f = await fixture(500);
    const before = await deliveries(f.db);
    const originalInbox = await inbox(f.db);
    await ensureNotificationIdentities(
      f.bounded.db,
      FIX.workspace,
      f.ids.slice(0, 100),
      f.namespace,
    );
    const first = await deliveries(f.db);
    expectAliases(first.slice(0, 100));
    expect(first.slice(100).every((row) => row.public_id === null)).toBe(true);
    expectBatches(f.requests, [100]);

    await ensureNotificationIdentities(f.bounded.db, FIX.workspace, f.ids, f.namespace);
    const repaired = await deliveries(f.db);
    expectAliases(repaired);
    expect(repaired.map((row) => ({ ...row, public_id: null }))).toEqual(before);
    expect(repaired.slice(0, 100)).toEqual(first.slice(0, 100));
    expect(await inbox(f.db)).toEqual(originalInbox);
    expectBatches(f.requests, [100, 100, 100, 100, 100]);
    expect(f.requests.flatMap((request) => request.request.input.deliveryIds)).toEqual(f.ids);
    expect(f.bounded.observed.maximumParameters).toBeLessThanOrEqual(100);

    const committed = await effects(f.db);
    await ensureNotificationIdentities(f.bounded.db, FIX.workspace, f.ids, f.namespace);
    expect(await deliveries(f.db)).toEqual(repaired);
    expect(await inbox(f.db)).toEqual(originalInbox);
    expect(await effects(f.db)).toEqual(committed);
    expectBatches(f.requests, [100, 100, 100, 100, 100]);
  });

  it("resumes a 101-row Cron backfill across every historical state and preserves acknowledged inbox rows", async () => {
    const f = await fixture(101);
    const before = await deliveries(f.db);
    const originalInbox = await inbox(f.db);
    expect(new Set(before.map((row) => row.state))).toEqual(new Set(STATES));
    await runNotificationIdentitySweep(f.bounded.db, f.namespace);
    const first = await deliveries(f.db);
    expectAliases(first.slice(0, 100));
    expect(first[100]).toEqual(before[100]);
    expectBatches(f.requests, [100]);

    await runNotificationIdentitySweep(f.bounded.db, f.namespace);
    const repaired = await deliveries(f.db);
    expectAliases(repaired);
    expect(repaired.slice(0, 100)).toEqual(first.slice(0, 100));
    expect(repaired.map((row) => ({ ...row, public_id: null }))).toEqual(before);
    expect(await inbox(f.db)).toEqual(originalInbox);
    expect(await f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expectBatches(f.requests, [100, 1]);

    const committed = await effects(f.db);
    await runNotificationIdentitySweep(f.bounded.db, f.namespace);
    expect(await deliveries(f.db)).toEqual(repaired);
    expect(await effects(f.db)).toEqual(committed);
    expectBatches(f.requests, [100, 1]);
  });

  it("leaves all legacy rows unassigned on an invalid Hub binding and repairs them on a valid retry", async () => {
    const f = await fixture(5);
    const before = await deliveries(f.db);
    const originalInbox = await inbox(f.db);
    const committed = await effects(f.db);
    await expect(
      ensureNotificationIdentities(
        f.bounded.db,
        FIX.workspace,
        f.ids,
        {} as DurableObjectNamespace,
      ),
    ).rejects.toMatchObject(REJECTED);
    expect(await deliveries(f.db)).toEqual(before);
    expect(await inbox(f.db)).toEqual(originalInbox);
    expect(await effects(f.db)).toEqual(committed);
    expect(f.requests).toEqual([]);

    await ensureNotificationIdentities(f.bounded.db, FIX.workspace, f.ids, f.namespace);
    const repaired = await deliveries(f.db);
    expectAliases(repaired);
    expect(repaired.map((row) => ({ ...row, public_id: null }))).toEqual(before);
    expect(await inbox(f.db)).toEqual(originalInbox);
    expectBatches(f.requests, [5]);
  });

  it("rejects duplicate and over-500 inputs before queries or commands while empty input is a no-op", async () => {
    const f = await fixture(1);
    const before = await deliveries(f.db);
    const committed = await effects(f.db);
    for (const ids of [
      [f.ids[0]!, f.ids[0]!],
      Array.from({ length: 501 }, (_, index) => legacyId(index)),
    ]) {
      await expect(
        ensureNotificationIdentities(f.bounded.db, FIX.workspace, ids, f.namespace),
      ).rejects.toMatchObject(REJECTED);
    }
    await ensureNotificationIdentities(f.bounded.db, FIX.workspace, [], f.namespace);
    expect(f.bounded.observed.calls).toBe(0);
    expect(f.requests).toEqual([]);
    expect(await deliveries(f.db)).toEqual(before);
    expect(await effects(f.db)).toEqual(committed);
  });
});

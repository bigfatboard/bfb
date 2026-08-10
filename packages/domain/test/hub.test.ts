// ABOUTME: Verifies WorkspaceHub FIFO idempotency and cursor allocation for C01.
// ABOUTME: Uses real hub.execute against migrated SQLite fixtures.

import { describe, expect, it } from "vitest";

import { WorkspaceHub, type HubCommand } from "../src/hub.js";
import { FIX } from "../src/fixtures.js";
import { openDomainDb } from "./helpers.js";

const echo: HubCommand<{ n: number }, { n: number }> = {
  name: "test.echo",
  run(input) {
    return input;
  },
};

describe("workspace hub", () => {
  it("returns stored idempotent results and advances cursor once", async () => {
    const db = openDomainDb();
    const hub = new WorkspaceHub(db);
    const first = await hub.execute(echo, {
      workspaceId: FIX.workspace,
      idempotencyKey: "k1",
      input: { n: 1 },
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
    });
    const second = await hub.execute(echo, {
      workspaceId: FIX.workspace,
      idempotencyKey: "k1",
      input: { n: 99 },
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
    });
    expect(first.ok && first.replayed).toBe(false);
    expect(second.ok && second.replayed).toBe(true);
    if (first.ok && second.ok) {
      expect(second.result).toEqual(first.result);
      expect(second.cursor).toBe(first.cursor);
    }
    const events = db.prepare(`SELECT COUNT(*) AS c FROM semantic_events`).get() as { c: number };
    expect(events.c).toBe(1);
  });

  it("serializes concurrent commands into monotonic cursors", async () => {
    const db = openDomainDb();
    const hub = new WorkspaceHub(db);
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        hub.execute(echo, {
          workspaceId: FIX.workspace,
          idempotencyKey: "c-" + n,
          input: { n },
          authorizationEpoch: 1,
          actorHumanId: FIX.owner,
        }),
      ),
    );
    const cursors = results.map((result) => (result.ok ? result.cursor : -1)).sort((a, b) => a - b);
    expect(cursors).toEqual([1, 2, 3, 4, 5]);
  });
});

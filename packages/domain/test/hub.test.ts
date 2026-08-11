// ABOUTME: Verifies WorkspaceHub FIFO idempotency, atomic commits, and failure isolation for C01.
// ABOUTME: Uses real hub.execute against migrated SQLite fixtures.

import { describe, expect, it } from "vitest";

import { DomainError, WorkspaceHub, type HubCommand } from "../src/hub.js";
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
    const db = await openDomainDb();
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
    const events = (await db.prepare(`SELECT COUNT(*) AS c FROM semantic_events`).get()) as {
      c: number;
    };
    expect(events.c).toBe(1);
    const audits = (await db.prepare(`SELECT COUNT(*) AS c FROM audit_events`).get()) as {
      c: number;
    };
    const outbox = (await db.prepare(`SELECT COUNT(*) AS c FROM outbox_records`).get()) as {
      c: number;
    };
    expect(audits.c).toBe(1);
    expect(outbox.c).toBe(1);
  });

  it("serializes concurrent commands into monotonic cursors", async () => {
    const db = await openDomainDb();
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

  it("rejects idempotency replay under a different authority", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const first = await hub.execute(echo, {
      workspaceId: FIX.workspace,
      idempotencyKey: "auth-bound",
      input: { n: 1 },
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
    });
    expect(first.ok).toBe(true);
    const second = await hub.execute(echo, {
      workspaceId: FIX.workspace,
      idempotencyKey: "auth-bound",
      input: { n: 1 },
      authorizationEpoch: 2,
      actorHumanId: FIX.owner,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("idempotency_authority_mismatch");
    }
  });

  it("rolls back mutation event audit outbox and idempotency when the command fails", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const failing: HubCommand<{ n: number }, { n: number }> = {
      name: "test.fail",
      async run(input, ctx) {
        await ctx.db
          .prepare(
            `INSERT INTO tenant_fixture_items (workspace_id, id, label, resource_version)
             VALUES (?, ?, ?, 1)`,
          )
          .run(ctx.workspaceId, "01JBFB01TEMFA1L00000000000", "partial");
        throw new DomainError("injected_failure", "force failure after partial write");
      },
    };
    const outcome = await hub.execute(failing, {
      workspaceId: FIX.workspace,
      idempotencyKey: "fail-1",
      input: { n: 1 },
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
    });
    expect(outcome.ok).toBe(false);
    const items = (await db.prepare(`SELECT COUNT(*) AS c FROM tenant_fixture_items`).get()) as {
      c: number;
    };
    const events = (await db.prepare(`SELECT COUNT(*) AS c FROM semantic_events`).get()) as {
      c: number;
    };
    const audits = (await db.prepare(`SELECT COUNT(*) AS c FROM audit_events`).get()) as {
      c: number;
    };
    const outbox = (await db.prepare(`SELECT COUNT(*) AS c FROM outbox_records`).get()) as {
      c: number;
    };
    const idem = (await db.prepare(`SELECT COUNT(*) AS c FROM idempotency_records`).get()) as {
      c: number;
    };
    expect(items.c).toBe(0);
    expect(events.c).toBe(0);
    expect(audits.c).toBe(0);
    expect(outbox.c).toBe(0);
    expect(idem.c).toBe(0);
  });

  it("preserves FIFO result order under delayed concurrent commands", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const delayed: HubCommand<{ n: number; delayMs: number }, { n: number }> = {
      name: "test.delayed",
      async run(input) {
        await new Promise((resolve) => setTimeout(resolve, input.delayMs));
        return { n: input.n };
      },
    };
    const started = await Promise.all(
      [
        { n: 1, delayMs: 30 },
        { n: 2, delayMs: 5 },
        { n: 3, delayMs: 15 },
      ].map((input) =>
        hub.execute(delayed, {
          workspaceId: FIX.workspace,
          idempotencyKey: "d-" + input.n,
          input,
          authorizationEpoch: 1,
          actorHumanId: FIX.owner,
        }),
      ),
    );
    const ordered = started
      .filter((result) => result.ok)
      .map((result) => (result.ok ? { n: result.result.n, cursor: result.cursor } : null))
      .filter(Boolean) as Array<{ n: number; cursor: number }>;
    ordered.sort((a, b) => a.cursor - b.cursor);
    expect(ordered.map((row) => row.n)).toEqual([1, 2, 3]);
  });
});

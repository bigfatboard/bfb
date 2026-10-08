// ABOUTME: Verifies WorkspaceHub FIFO idempotency, atomic commits, and failure isolation for C01.
// ABOUTME: Uses real hub.execute against migrated SQLite fixtures.

import { createAuthorizationContext } from "@bfb/db";
import { describe, expect, it } from "vitest";

import {
  DomainError,
  listWorkspaceEvents,
  readEventHighWater,
  WorkspaceHub,
  type HubCommand,
} from "../src/hub.js";
import { clearWorkspaceHubs, workspaceHub } from "../src/hub-registry.js";
import { FIX } from "../src/fixtures.js";
import { randomUlid } from "../src/ids.js";
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
      idempotencyKey: "echo-key-1",
      input: { n: 1 },
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
    });
    const second = await hub.execute(echo, {
      workspaceId: FIX.workspace,
      idempotencyKey: "echo-key-1",
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
          idempotencyKey: "cursor-key-" + n,
          input: { n },
          authorizationEpoch: 1,
          actorHumanId: FIX.owner,
        }),
      ),
    );
    const cursors = results.map((result) => (result.ok ? result.cursor : -1)).sort((a, b) => a - b);
    expect(cursors).toEqual([1, 2, 3, 4, 5]);
  });

  it("passes the current request input to post-cache authority without rewriting the receipt", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const requestInput = { n: 1 };
    const command: HubCommand<{ n: number }, { n: number }> = {
      ...echo,
      name: "test.replay-authority",
      auditInput: () => ({}),
      async replayResult(result, ctx, input) {
        expect(input).toBe(requestInput);
        expect(ctx.actorHumanId).toBe(FIX.owner);
        expect(ctx.authorizationEpoch).toBe(1);
        return { n: result.n + input.n };
      },
    };
    const request = {
      workspaceId: FIX.workspace,
      idempotencyKey: "replay-input-authority",
      input: requestInput,
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
    };
    expect(await hub.execute(command, request)).toMatchObject({
      ok: true,
      replayed: false,
      result: { n: 1 },
    });
    const stored = await db
      .prepare("SELECT result_json FROM idempotency_records WHERE idempotency_key = ?")
      .get(request.idempotencyKey);
    expect(await hub.execute(command, request)).toMatchObject({
      ok: true,
      replayed: true,
      result: { n: 2 },
    });
    expect(
      await db
        .prepare("SELECT result_json FROM idempotency_records WHERE idempotency_key = ?")
        .get(request.idempotencyKey),
    ).toEqual(stored);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM semantic_events").get()).toEqual({ n: 1 });
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

  it("rejects an invalid command envelope without committing effects", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const outcome = await hub.execute(echo, {
      workspaceId: FIX.workspace,
      idempotencyKey: "short",
      input: { n: 1 },
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "invalid_command_request" },
    });
    const effects = (await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM semantic_events) AS events,
           (SELECT COUNT(*) FROM idempotency_records) AS idempotency`,
      )
      .get()) as { events: number; idempotency: number };
    expect(effects).toEqual({ events: 0, idempotency: 0 });
  });

  it("records a typed system principal without fabricating a human actor", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const systemId = randomUlid();
    const outcome = await hub.execute(echo, {
      workspaceId: FIX.workspace,
      idempotencyKey: "system-command",
      input: { n: 1 },
      authorizationEpoch: 1,
      actorSystemId: systemId,
    });
    expect(outcome.ok).toBe(true);
    const audit = (await db
      .prepare(`SELECT actor_principal_id, payload_json FROM audit_events`)
      .get()) as { actor_principal_id: string; payload_json: string };
    expect(audit.actor_principal_id).toBe(systemId);
    expect(JSON.parse(audit.payload_json)).toMatchObject({ actor: { systemId } });
  });

  it("rejects reuse of an idempotency key for a different command", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const first = await hub.execute(echo, {
      workspaceId: FIX.workspace,
      idempotencyKey: "command-bound",
      input: { n: 1 },
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
    });
    expect(first.ok).toBe(true);

    const other: HubCommand<{ n: number }, { n: number }> = {
      name: "test.other",
      run(input) {
        return input;
      },
    };
    const second = await hub.execute(other, {
      workspaceId: FIX.workspace,
      idempotencyKey: "command-bound",
      input: { n: 1 },
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("idempotency_command_mismatch");
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
          .run(ctx.workspaceId, randomUlid(), "partial");
        throw new DomainError("injected_failure", "force failure after partial write");
      },
    };
    const outcome = await hub.execute(failing, {
      workspaceId: FIX.workspace,
      idempotencyKey: "failure-key-1",
      input: { n: 1 },
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("injected_failure");
    }
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

  it("replaces non-domain failure detail with a uniform command failure", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const request = {
      workspaceId: FIX.workspace,
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      input: { n: 1 },
    };
    const driverFailure: HubCommand<{ n: number }, { n: number }> = {
      name: "test.driver-failure",
      async run() {
        throw new Error("UNIQUE constraint failed: tenant_fixture_items.id");
      },
    };
    const driverOutcome = await hub.execute(driverFailure, {
      ...request,
      idempotencyKey: "driver-failure-key-1",
    });
    expect(driverOutcome).toEqual({
      ok: false,
      error: { code: "command_failed", message: "command failed" },
    });
    const codedFailure: HubCommand<{ n: number }, { n: number }> = {
      name: "test.coded-failure",
      async run() {
        throw Object.assign(new Error("D1_ERROR: no such table: missing"), {
          code: "SQLITE_ERROR",
        });
      },
    };
    const codedOutcome = await hub.execute(codedFailure, {
      ...request,
      idempotencyKey: "coded-failure-key-1",
    });
    expect(codedOutcome).toEqual({
      ok: false,
      error: { code: "command_failed", message: "command failed" },
    });
    const domainOutcome = await hub.execute(
      {
        name: "test.domain-failure",
        async run() {
          throw new DomainError("injected_failure", "force failure after partial write");
        },
      },
      { ...request, idempotencyKey: "domain-failure-key-1" },
    );
    expect(domainOutcome).toEqual({
      ok: false,
      error: { code: "injected_failure", message: "force failure after partial write" },
    });
  });

  it("rejects a stale version without advancing any command-kernel effect", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const itemId = randomUlid();
    await db
      .prepare(
        `INSERT INTO tenant_fixture_items (workspace_id, id, label, resource_version)
         VALUES (?, ?, 'current', 2)`,
      )
      .run(FIX.workspace, itemId);
    const guardedUpdate: HubCommand<
      { itemId: string; expectedVersion: number },
      { resourceVersion: number }
    > = {
      name: "test.guarded-update",
      async run(input, ctx) {
        const current = (await ctx.db
          .prepare(
            `SELECT resource_version FROM tenant_fixture_items
             WHERE workspace_id = ? AND id = ?`,
          )
          .get(ctx.workspaceId, input.itemId)) as { resource_version: number } | undefined;
        if (!current || current.resource_version !== input.expectedVersion) {
          throw new DomainError("stale_version", "fixture item version changed");
        }
        await ctx.db
          .prepare(
            `UPDATE tenant_fixture_items SET label = 'updated', resource_version = ?
             WHERE workspace_id = ? AND id = ?`,
          )
          .run(current.resource_version + 1, ctx.workspaceId, input.itemId);
        return { resourceVersion: current.resource_version + 1 };
      },
    };
    const outcome = await hub.execute(guardedUpdate, {
      workspaceId: FIX.workspace,
      idempotencyKey: "stale-version-key",
      input: { itemId, expectedVersion: 1 },
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
    });
    expect(outcome).toMatchObject({ ok: false, error: { code: "stale_version" } });
    const effects = (await db
      .prepare(
        `SELECT
           (SELECT resource_version FROM tenant_fixture_items WHERE id = ?) AS version,
           (SELECT COUNT(*) FROM workspace_cursors) AS cursors,
           (SELECT COUNT(*) FROM semantic_events) AS events,
           (SELECT COUNT(*) FROM audit_events) AS audits,
           (SELECT COUNT(*) FROM outbox_records) AS outbox,
           (SELECT COUNT(*) FROM idempotency_records) AS idempotency`,
      )
      .get(itemId)) as Record<string, number>;
    expect(effects).toEqual({
      version: 2,
      cursors: 0,
      events: 0,
      audits: 0,
      outbox: 0,
      idempotency: 0,
    });
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
          idempotencyKey: "delay-key-" + input.n,
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

  it("shares one FIFO lane across request-style hub resolutions for a workspace", async () => {
    const db = await openDomainDb();
    clearWorkspaceHubs(db);
    const delayed: HubCommand<{ n: number; delayMs: number }, { n: number }> = {
      name: "test.registry-delayed",
      async run(input) {
        await new Promise((resolve) => setTimeout(resolve, input.delayMs));
        return { n: input.n };
      },
    };
    // Simulate three independent request handlers resolving the hub separately.
    const results = await Promise.all(
      [
        { n: 1, delayMs: 25 },
        { n: 2, delayMs: 5 },
        { n: 3, delayMs: 10 },
      ].map((input) => {
        const hub = workspaceHub(db, FIX.workspace);
        return hub.execute(delayed, {
          workspaceId: FIX.workspace,
          idempotencyKey: "registry-key-" + input.n,
          input,
          authorizationEpoch: 1,
          actorHumanId: FIX.owner,
        });
      }),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const ordered = results
      .map((result) => (result.ok ? { n: result.result.n, cursor: result.cursor } : null))
      .filter(Boolean) as Array<{ n: number; cursor: number }>;
    ordered.sort((a, b) => a.cursor - b.cursor);
    expect(ordered.map((row) => row.n)).toEqual([1, 2, 3]);
    expect(workspaceHub(db, FIX.workspace)).toBe(workspaceHub(db, FIX.workspace));
  });

  it("retains semantic command history while public replay and high-water are held", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    for (const n of [1, 2]) {
      const outcome = await hub.execute(echo, {
        workspaceId: FIX.workspace,
        idempotencyKey: `replay-key-${n}`,
        input: { n },
        authorizationEpoch: 1,
        actorHumanId: FIX.owner,
      });
      expect(outcome.ok).toBe(true);
    }
    const authorization = createAuthorizationContext({
      workspaceId: FIX.workspace,
      principalId: FIX.owner,
      authorizationEpoch: 1,
      jurisdiction: "eu",
    });
    await expect(readEventHighWater(db, authorization)).rejects.toMatchObject({
      code: "request_rejected",
      message: "event feeds are unavailable",
    });
    await expect(
      listWorkspaceEvents(db, authorization, {
        afterCursor: 0,
        throughCursor: 2,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "request_rejected", message: "event feeds are unavailable" });
    const rows = await db
      .prepare(
        "SELECT workspace_cursor,payload_json FROM semantic_events ORDER BY workspace_cursor",
      )
      .all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ workspace_cursor: 1 });
    expect(JSON.parse((rows[0] as { payload_json: string }).payload_json)).toMatchObject({
      result: { n: 1 },
    });
  });

  it("rejects invalid replay bounds before querying event history", async () => {
    const db = await openDomainDb();
    const authorization = createAuthorizationContext({
      workspaceId: FIX.workspace,
      principalId: FIX.owner,
      authorizationEpoch: 1,
      jurisdiction: "eu",
    });
    await expect(
      listWorkspaceEvents(db, authorization, {
        afterCursor: 2,
        throughCursor: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid_event_range" });
  });
});

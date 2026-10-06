// ABOUTME: Verifies source-identified artifact audit dispatch is atomic, bounded and replay-safe.
// ABOUTME: Keeps original private outbox payloads out of public semantic and audit projections.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_RECOVERY_SYSTEM_ID } from "../src/artifacts.js";
import {
  dispatchArtifactAuditCommand,
  listArtifactAuditCandidates,
} from "../src/artifact-maintenance.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub } from "../src/hub.js";
import { randomUlid, syntheticUlid } from "../src/ids.js";
import { openDomainDb } from "./helpers.js";

const NOW = "2026-10-06T12:00:00.000Z";
const OCCURRED = "2026-10-06T11:59:00.000Z";
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function fixture() {
  const db = await openDomainDb();
  const hub = new WorkspaceHub(db);
  async function seed(action = "artifact.grant_consumed", workspaceId = FIX.workspace) {
    const id = randomUlid();
    await db
      .prepare(
        `INSERT INTO artifact_audit_outbox (workspace_id,id,version_id,grant_id,action,payload_json,created_at,dispatched_at) VALUES (?,?,NULL,NULL,?,?,?,NULL)`,
      )
      .run(
        workspaceId,
        id,
        action,
        JSON.stringify({
          private_body: "DO-NOT-PROJECT-PRIVATE-BODY",
          secret: "DO-NOT-PROJECT-SECRET",
          path: "DO-NOT-PROJECT-PATH",
        }),
        OCCURRED,
      );
    return id;
  }
  const request = (id: string) => ({
    workspaceId: FIX.workspace,
    actorSystemId: ARTIFACT_RECOVERY_SYSTEM_ID,
    authorizationEpoch: 1,
    idempotencyKey: `artifact-audit:${id}`,
    input: { outboxId: id },
  });
  const dispatch = (id: string) => hub.execute(dispatchArtifactAuditCommand, request(id));
  async function count(table: string, column: string, id: string) {
    return (
      (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(id)) as {
        n: number;
      }
    ).n;
  }
  return { db, hub, seed, request, dispatch, count };
}

describe("artifact audit maintenance", () => {
  it.each(["artifact.view_issued", "artifact.view_redeemed"])(
    "dispatches %s once without projecting private payloads",
    async (action) => {
      const f = await fixture();
      const id = await f.seed(action);
      expect(await listArtifactAuditCandidates(f.db)).toEqual([
        { workspace_id: FIX.workspace, id },
      ]);
      const outcome = await f.dispatch(id);
      expect(outcome).toMatchObject({
        ok: true,
        result: { outbox_id: id, source_action: action, occurred_at: OCCURRED },
      });
      expect(await f.dispatch(id)).toMatchObject({ ok: true, replayed: true });
      expect(await f.count("semantic_events", "event_id", id)).toBe(1);
      expect(await f.count("audit_events", "audit_id", id)).toBe(1);
      const projection = JSON.stringify(
        await f.db.prepare("SELECT payload_json FROM semantic_events WHERE event_id = ?").all(id),
      );
      expect(projection).not.toContain("DO-NOT-PROJECT");
    },
  );
  it("projects one original source with distinct occurrence/dispatch time and no private payload", async () => {
    const f = await fixture(),
      id = await f.seed();
    const outcome = await f.dispatch(id);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.error.code);
    expect(outcome.result).toEqual({
      schema_version: 1,
      outbox_id: id,
      version_id: null,
      grant_id: null,
      source_action: "artifact.grant_consumed",
      occurred_at: OCCURRED,
    });
    expect(outcome.cursor).toBe(2);
    const event = (await f.db
      .prepare(
        `SELECT workspace_cursor,kind,payload_json,created_at FROM semantic_events WHERE event_id=?`,
      )
      .get(id)) as Record<string, unknown>;
    expect(event).toMatchObject({
      workspace_cursor: 1,
      kind: "artifact.grant_consumed",
      created_at: NOW,
    });
    const stamp = (await f.db
      .prepare(`SELECT dispatched_at FROM artifact_audit_outbox WHERE id=?`)
      .get(id)) as { dispatched_at: string };
    expect(stamp.dispatched_at).toBe(NOW);
    const projection = JSON.stringify({
      events: await f.db.prepare(`SELECT * FROM semantic_events`).all(),
      audit: await f.db.prepare(`SELECT * FROM audit_events`).all(),
      outbox: await f.db.prepare(`SELECT * FROM outbox_records`).all(),
      outcomes: await f.db.prepare(`SELECT * FROM idempotency_records`).all(),
    });
    expect(projection).not.toContain("DO-NOT-PROJECT");
    expect(await f.count("audit_events", "audit_id", id)).toBe(1);
  });
  it("replays without another projection and refuses re-dispatch after transient cache loss", async () => {
    const f = await fixture(),
      id = await f.seed();
    expect((await f.dispatch(id)).ok).toBe(true);
    expect(await f.dispatch(id)).toMatchObject({ ok: true, replayed: true });
    await f.db
      .prepare(`DELETE FROM idempotency_records WHERE workspace_id=? AND idempotency_key=?`)
      .run(FIX.workspace, `artifact-audit:${id}`);
    expect((await f.dispatch(id)).ok).toBe(false);
    expect(await f.count("semantic_events", "event_id", id)).toBe(1);
    expect(await f.count("audit_events", "audit_id", id)).toBe(1);
  });
  it("keeps the source identity unique across same-time independent lane instances", async () => {
    const f = await fixture(),
      id = await f.seed();
    const outcomes = await Promise.all([
      f.dispatch(id),
      new WorkspaceHub(f.db).execute(dispatchArtifactAuditCommand, {
        ...f.request(id),
        idempotencyKey: `artifact-audit-other:${id}`,
      }),
    ]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(await f.count("semantic_events", "event_id", id)).toBe(1);
    expect(await f.count("audit_events", "audit_id", id)).toBe(1);
  });
  it("rolls the source stamp and projections back if the late Hub outbox insert fails", async () => {
    const f = await fixture(),
      id = await f.seed();
    await f.db
      .prepare(
        `CREATE TRIGGER fail_artifact_dispatch BEFORE INSERT ON outbox_records WHEN NEW.kind = 'artifact.dispatch_audit' BEGIN SELECT RAISE(ABORT,'synthetic late dispatch failure'); END`,
      )
      .run();
    expect((await f.dispatch(id)).ok).toBe(false);
    expect(await f.count("semantic_events", "event_id", id)).toBe(0);
    expect(await f.count("audit_events", "audit_id", id)).toBe(0);
    expect(
      await f.db.prepare(`SELECT dispatched_at FROM artifact_audit_outbox WHERE id=?`).get(id),
    ).toEqual({ dispatched_at: null });
    await f.db.prepare(`DROP TRIGGER fail_artifact_dispatch`).run();
    expect((await f.dispatch(id)).ok).toBe(true);
  });
  it("requires only the designated system principal and current epoch before cached outcomes", async () => {
    const f = await fixture(),
      id = await f.seed();
    expect((await f.dispatch(id)).ok).toBe(true);
    for (const changed of [
      { actorSystemId: syntheticUlid("OTHERJOB") },
      { actorHumanId: FIX.owner },
      { actorRunnerId: syntheticUlid("RUNNER") },
      { authorizationEpoch: 2 },
      { input: { outboxId: id, body: "forbidden" } },
    ]) {
      expect(
        (await f.hub.execute(dispatchArtifactAuditCommand, { ...f.request(id), ...changed })).ok,
      ).toBe(false);
    }
    expect(await f.count("semantic_events", "event_id", id)).toBe(1);
  });
  it("does not dispatch foreign or held-package sources", async () => {
    const f = await fixture();
    const held = await f.seed("artifact.reviewed"),
      own = await f.seed();
    expect((await f.dispatch(held)).ok).toBe(false);
    expect(
      (
        await f.hub.execute(dispatchArtifactAuditCommand, {
          ...f.request(own),
          workspaceId: syntheticUlid("OTHERWORKSPACE"),
        })
      ).ok,
    ).toBe(false);
    expect(await listArtifactAuditCandidates(f.db)).toEqual([
      { workspace_id: FIX.workspace, id: own },
    ]);
  });
  it("bounds scans and never stamps rows while selecting", async () => {
    const f = await fixture();
    for (let i = 0; i < 4; i++) await f.seed();
    expect(await listArtifactAuditCandidates(f.db, 2)).toHaveLength(2);
    expect(await listArtifactAuditCandidates(f.db, 4)).toHaveLength(4);
    for (const limit of [0, 101, 1.5, NaN])
      await expect(listArtifactAuditCandidates(f.db, limit)).rejects.toThrow();
    expect(
      await f.db
        .prepare(`SELECT COUNT(*) AS n FROM artifact_audit_outbox WHERE dispatched_at IS NOT NULL`)
        .get(),
    ).toEqual({ n: 0 });
  });
});

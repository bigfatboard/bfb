// ABOUTME: Exercises artifact Cron dispatch through jurisdiction-scoped workspace command lanes.
// ABOUTME: Proves stale scans, missing Hub bindings and lost replies cannot bypass canonical recovery.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_RECOVERY_SYSTEM_ID,
  createArtifactCommand,
  FIX,
  issueArtifactGrantCommand,
  mintUploadGrantSecret,
  randomUlid,
  WorkspaceHub,
} from "@bfb/domain";
import { openDomainDb } from "../../../packages/domain/test/helpers.js";
import { runArtifactAuditDispatch, runArtifactSweep } from "../src/artifacts/maintenance.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";

const CREATED = "2026-10-06T12:00:00.000Z";
const NOW = "2026-10-06T12:40:00.000Z";
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(CREATED);
});
afterEach(() => vi.useRealTimers());

async function fixture() {
  const db = await openDomainDb();
  const hub = new WorkspaceHub(db);
  const created = await hub.execute(createArtifactCommand, {
    workspaceId: FIX.workspace,
    actorHumanId: FIX.owner,
    authorizationEpoch: 1,
    idempotencyKey: randomUlid(),
    input: {
      format: "markdown",
      role: "review",
      declaredSize: 3,
      expectedDigest: "a".repeat(64),
      grantSecretHash: mintUploadGrantSecret().secretHash,
    },
  });
  if (!created.ok) throw new Error(created.error.code);
  const versionId = created.result.version_id;
  const ns = createTestWorkspaceHubNamespace(db);
  const jurisdiction = vi.fn(() => ns);
  const idFromName = vi.fn(ns.idFromName.bind(ns));
  Object.assign(ns, { jurisdiction, idFromName });
  const state = async () =>
    (
      (await db.prepare(`SELECT state FROM artifact_versions WHERE id=?`).get(versionId)) as {
        state: string;
      }
    ).state;
  return { db, hub, ns, versionId, jurisdiction, idFromName, state };
}

describe("artifact maintenance transport", () => {
  it("routes eligible abandonment through the workspace's jurisdiction and system actor", async () => {
    const f = await fixture();
    vi.setSystemTime(NOW);
    const bodies: Array<Record<string, unknown>> = [];
    const get = f.ns.get.bind(f.ns);
    Object.assign(f.ns, {
      get(id: DurableObjectId) {
        const stub = get(id);
        return {
          async fetch(input: RequestInfo | URL, init: RequestInit) {
            bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
            return stub.fetch(input, init);
          },
        };
      },
    });
    expect(await runArtifactSweep(f.db, NOW, f.ns)).toEqual({ marked: [f.versionId] });
    expect(await f.state()).toBe("failed");
    expect(f.jurisdiction).toHaveBeenCalledWith("eu");
    expect(f.idFromName).toHaveBeenCalledWith(FIX.workspace);
    expect(bodies).toEqual([
      {
        commandName: "artifact.mark_failed",
        request: {
          workspaceId: FIX.workspace,
          actorSystemId: ARTIFACT_RECOVERY_SYSTEM_ID,
          authorizationEpoch: 1,
          idempotencyKey: `artifact-expire:${f.versionId}`,
          input: { versionId: f.versionId },
        },
      },
    ]);
  });

  it("uses the Hub wall clock even when a future scan claims a fresh upload is old", async () => {
    const f = await fixture();
    expect(await runArtifactSweep(f.db, NOW, f.ns)).toEqual({ marked: [] });
    expect(f.idFromName).toHaveBeenCalled();
    expect(await f.state()).toBe("uploading");
  });

  it("preserves an upload regranted after selection but before command execution", async () => {
    const f = await fixture();
    vi.setSystemTime(NOW);
    const get = f.ns.get.bind(f.ns);
    Object.assign(f.ns, {
      get(id: DurableObjectId) {
        const stub = get(id);
        return {
          async fetch(input: RequestInfo | URL, init: RequestInit) {
            const regrant = await f.hub.execute(issueArtifactGrantCommand, {
              workspaceId: FIX.workspace,
              actorHumanId: FIX.owner,
              authorizationEpoch: 1,
              idempotencyKey: randomUlid(),
              input: {
                versionId: f.versionId,
                grantSecretHash: mintUploadGrantSecret().secretHash,
              },
            });
            expect(regrant.ok).toBe(true);
            return stub.fetch(input, init);
          },
        };
      },
    });
    expect(await runArtifactSweep(f.db, NOW, f.ns)).toEqual({ marked: [] });
    expect(await f.state()).toBe("uploading");
  });

  it("never falls back to local mutation when a configured namespace is invalid or offline", async () => {
    const f = await fixture();
    vi.setSystemTime(NOW);
    for (const ns of [{} as DurableObjectNamespace, f.ns]) {
      Object.assign(f.ns, {
        get() {
          return {
            fetch: async () => {
              throw new Error("synthetic unavailable Hub");
            },
          };
        },
      });
      expect(await runArtifactSweep(f.db, NOW, ns)).toEqual({ marked: [] });
      expect(await runArtifactAuditDispatch(f.db, ns)).toEqual({ dispatched: 0 });
    }
    expect(await f.state()).toBe("uploading");
    expect(
      await f.db
        .prepare(`SELECT COUNT(*) AS n FROM artifact_audit_outbox WHERE dispatched_at IS NOT NULL`)
        .get(),
    ).toEqual({ n: 0 });
  });

  it("does not duplicate an audit projection when the Hub response is lost", async () => {
    const f = await fixture();
    vi.setSystemTime(NOW);
    const get = f.ns.get.bind(f.ns);
    Object.assign(f.ns, {
      get(id: DurableObjectId) {
        const stub = get(id);
        return {
          async fetch(input: RequestInfo | URL, init: RequestInit) {
            await stub.fetch(input, init);
            throw new Error("synthetic lost committed response");
          },
        };
      },
    });
    expect(await runArtifactAuditDispatch(f.db, f.ns)).toEqual({ dispatched: 0 });
    expect(await runArtifactAuditDispatch(f.db, createTestWorkspaceHubNamespace(f.db))).toEqual({
      dispatched: 0,
    });
    expect(
      await f.db
        .prepare(`SELECT COUNT(*) AS n FROM semantic_events WHERE kind = 'artifact.grant_issued'`)
        .get(),
    ).toEqual({ n: 1 });
    expect(
      await f.db
        .prepare(`SELECT COUNT(*) AS n FROM artifact_audit_outbox WHERE dispatched_at IS NULL`)
        .get(),
    ).toEqual({ n: 0 });
  });

  it("routes a mixed-workspace audit backlog to each persisted jurisdiction", async () => {
    const f = await fixture();
    const globalWorkspace = randomUlid();
    const source = randomUlid();
    await f.db
      .prepare(
        `INSERT INTO workspaces (id,slug,jurisdiction,created_at,resource_version)
      VALUES (?,'synthetic-global-audit','global',?,1)`,
      )
      .run(globalWorkspace, CREATED);
    await f.db
      .prepare(
        `INSERT INTO artifact_audit_outbox
      (workspace_id,id,version_id,grant_id,action,payload_json,created_at,dispatched_at)
      VALUES (?,?,NULL,NULL,'artifact.abandoned','{}',?,NULL)`,
      )
      .run(globalWorkspace, source, CREATED);
    vi.setSystemTime(NOW);
    expect(await runArtifactAuditDispatch(f.db, f.ns)).toEqual({ dispatched: 2 });
    expect(f.jurisdiction).toHaveBeenCalledExactlyOnceWith("eu");
    expect(f.idFromName).toHaveBeenCalledWith(FIX.workspace);
    expect(f.idFromName).toHaveBeenCalledWith(globalWorkspace);
    expect(
      await f.db.prepare(`SELECT workspace_id FROM semantic_events WHERE event_id=?`).get(source),
    ).toEqual({ workspace_id: globalWorkspace });
  });

  it("retries undispatched audit sources after a namespace outage", async () => {
    const f = await fixture();
    vi.setSystemTime(NOW);
    Object.assign(f.ns, {
      get() {
        return {
          fetch: async () => {
            throw new Error("synthetic unavailable Hub");
          },
        };
      },
    });
    expect(await runArtifactAuditDispatch(f.db, f.ns)).toEqual({ dispatched: 0 });
    expect(await runArtifactAuditDispatch(f.db, createTestWorkspaceHubNamespace(f.db))).toEqual({
      dispatched: 1,
    });
    expect(await runArtifactAuditDispatch(f.db, createTestWorkspaceHubNamespace(f.db))).toEqual({
      dispatched: 0,
    });
  });
});

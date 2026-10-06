// ABOUTME: Proves current private-task authority on human artifact publication, review and delivery.
// ABOUTME: Synthetic policies and staged D1 revocation races preserve grant, byte and audit atomicity.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  artifactHash,
  ARTIFACT_RECOVERY_SYSTEM_ID,
  createArtifactCommand,
  finalizeArtifactCommand,
  issueArtifactGrantCommand,
  listAbandonedArtifactUploads,
  markArtifactFailedCommand,
  mintUploadGrantSecret,
  recordVerifiedUpload,
  redeemUploadGrant,
} from "../src/artifacts.js";
import {
  artifactEvidenceVersionMap,
  getArtifactReviewStatus,
  listArtifactReviews,
  listArtifactsWithReviewState,
  readReviewTimerContext,
  recordReviewCommand,
} from "../src/artifact-reviews.js";
import {
  createViewGrantCommand,
  mintViewGrantSecret,
  mintViewNonce,
  redeemViewGrant,
} from "../src/artifact-views.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub, type CommandOutcome, type HubCommand } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { openDomainDb } from "./helpers.js";
import { resultStagedD1 } from "./result-fixture.js";

const NOW = "2026-10-06T12:00:00.000Z";
const DIGEST = artifactHash("synthetic private artifact");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

function result<T>(outcome: CommandOutcome<T>): T {
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
  if (!outcome.ok) throw new Error(outcome.error.code);
  return outcome.result;
}

async function fixture() {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db),
    taskId = randomUlid(),
    runId = randomUlid();
  await db
    .prepare(
      `INSERT INTO tasks (workspace_id,id,project_id,title,state,priority,next_owner_type,punchline,resource_version,created_by_human_id,created_at)
    VALUES (?,?,?,'Synthetic private artifact task','ready','P2','unassigned','Synthetic',1,?,?)`,
    )
    .run(FIX.workspace, taskId, FIX.projectA, FIX.member, NOW);
  await db
    .prepare(
      `INSERT INTO runs (workspace_id,id,project_id,task_id,requested_by_human_id,agent_profile_id,result_state,activity,resource_version,created_at)
    VALUES (?,?,?,?,?,?,'open','unknown',1,?)`,
    )
    .run(FIX.workspace, runId, FIX.projectA, taskId, FIX.member, FIX.profileCodex, NOW);
  // Policy and grant writes are synthetic fixtures, never private creation commands.
  await db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, taskId, FIX.member, NOW);
  function human<I, R>(
    command: HubCommand<I, R>,
    input: I,
    humanId = FIX.member,
    key = randomUlid(),
    target = hub,
  ) {
    return target.execute(command, {
      workspaceId: FIX.workspace,
      actorHumanId: humanId,
      authorizationEpoch: 1,
      idempotencyKey: key,
      now: NOW,
      input,
    });
  }
  async function grant(
    permission: "read" | "contribute" | "edit",
    humanId = FIX.owner,
    grantedTaskId = taskId,
  ) {
    const id = randomUlid();
    await db
      .prepare(
        "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,?,?)",
      )
      .run(FIX.workspace, id, grantedTaskId, humanId, permission, NOW);
    return id;
  }
  const revoke = (id: string) =>
    db
      .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
      .run(NOW, FIX.workspace, id);
  const access = (humanId = FIX.owner) => ({
    workspaceId: FIX.workspace,
    humanId,
    authorizationEpoch: 1,
  });
  const input = (boundRun: string | null = runId) => ({
    runId: boundRun,
    format: "markdown" as const,
    role: "review" as const,
    declaredSize: 26,
    expectedDigest: DIGEST,
    grantSecretHash: mintUploadGrantSecret().secretHash,
  });
  async function create(humanId = FIX.member, boundRun: string | null = runId) {
    const minted = mintUploadGrantSecret();
    return {
      ...result(
        await human(
          createArtifactCommand,
          { ...input(boundRun), grantSecretHash: minted.secretHash },
          humanId,
        ),
      ),
      secret: minted.secret,
    };
  }
  function consume(created: Awaited<ReturnType<typeof create>>) {
    return db.withTransaction((tx) =>
      redeemUploadGrant(tx, {
        grantId: created.upload_grant.grant_id,
        secret: created.secret,
        now: NOW,
      }),
    );
  }
  async function verified() {
    const created = await create(),
      consumed = await consume(created);
    await db.withTransaction((tx) =>
      recordVerifiedUpload(tx, {
        grantId: consumed.grantId,
        consumeAttemptId: consumed.consumeAttemptId,
        contentHash: DIGEST,
        size: 26,
        now: NOW,
      }),
    );
    return created;
  }
  async function available() {
    const created = await verified();
    result(
      await human(finalizeArtifactCommand, {
        versionId: created.version_id,
        contentHash: DIGEST,
        size: 26,
      }),
    );
    return created;
  }
  async function view(versionId: string, humanId = FIX.owner) {
    const minted = mintViewGrantSecret(),
      nonce = mintViewNonce();
    const grant = result(
      await human(
        createViewGrantCommand,
        {
          versionId,
          grantSecretHash: minted.secretHash,
          viewNonce: nonce,
          sessionHash: artifactHash("synthetic session"),
        },
        humanId,
      ),
    );
    return { viewId: grant.view_id, secret: minted.secret, nonce, now: NOW };
  }
  const review = (created: Awaited<ReturnType<typeof create>>) => ({
    artifactId: created.artifact_id,
    versionId: created.version_id,
    expectedContentHash: DIGEST,
    expectedLatestVersionId: created.version_id,
    decision: "comment" as const,
    comment: "Synthetic private review",
  });
  async function privateTimer() {
    const timerTaskId = randomUlid(),
      timerId = randomUlid(),
      observationId = randomUlid();
    await db
      .prepare(
        `INSERT INTO tasks (workspace_id,id,project_id,title,state,priority,next_owner_type,punchline,resource_version,created_by_human_id,created_at)
         VALUES (?,?,?,'Synthetic private timer task','ready','P2','unassigned','Synthetic',1,?,?)`,
      )
      .run(FIX.workspace, timerTaskId, FIX.projectA, FIX.member, NOW);
    await db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, timerTaskId, FIX.member, NOW);
    await db
      .prepare(
        `INSERT INTO review_timers
         (workspace_id,id,task_id,run_id,started_by_human_id,started_at,stopped_at,state,resource_version)
         VALUES (?,?,?,NULL,?,?,NULL,'open',1)`,
      )
      .run(FIX.workspace, timerId, timerTaskId, FIX.member, NOW);
    await db
      .prepare(
        `INSERT INTO review_timer_observations
         (workspace_id,observation_id,timer_id,observed_kind,actor_type,actor_id,occurred_at)
         VALUES (?,?,?,'started','human',?,?)`,
      )
      .run(FIX.workspace, observationId, timerId, FIX.member, NOW);
    return { timerTaskId, timerId, observationId };
  }
  async function counts() {
    return Promise.all(
      [
        "artifacts",
        "artifact_versions",
        "artifact_upload_grants",
        "artifact_upload_consumptions",
        "artifact_objects",
        "artifact_upload_receipts",
        "artifact_upload_receipt_sources",
        "artifact_view_grants",
        "artifact_reviews",
        "artifact_audit_outbox",
      ].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    );
  }
  return {
    db,
    hub,
    taskId,
    runId,
    human,
    grant,
    revoke,
    access,
    input,
    create,
    consume,
    verified,
    available,
    view,
    review,
    privateTimer,
    counts,
  };
}

describe("private artifact delivery", () => {
  it("denies an unshared workspace owner exactly like a missing run", async () => {
    const f = await fixture();
    const hidden = await f.human(createArtifactCommand, f.input(), FIX.owner);
    const missing = await f.human(createArtifactCommand, f.input(randomUlid()), FIX.owner);
    expect(hidden).toMatchObject({ ok: false, error: { code: "request_rejected" } });
    expect(missing).toMatchObject({ ok: false, error: { code: "request_rejected" } });
    expect(await f.db.prepare("SELECT * FROM artifact_versions").all()).toEqual([]);
  });
  it("allows a current read grant to inspect and view, but not publish or review", async () => {
    const f = await fixture(),
      created = await f.available();
    await f.grant("read");
    expect(
      await getArtifactReviewStatus(
        f.db,
        FIX.workspace,
        created.artifact_id,
        [FIX.projectA],
        f.access(),
      ),
    ).toBeDefined();
    expect(
      await listArtifactsWithReviewState(
        f.db,
        FIX.workspace,
        [FIX.projectA],
        undefined,
        f.access(),
      ),
    ).toHaveLength(1);
    expect(
      (await artifactEvidenceVersionMap(f.db, FIX.workspace, f.access(), [FIX.projectA])).size,
    ).toBe(1);
    const viewed = await f.view(created.version_id);
    expect(await f.db.withTransaction((tx) => redeemViewGrant(tx, viewed))).toMatchObject({
      versionId: created.version_id,
    });
    expect(await f.human(createArtifactCommand, f.input(), FIX.owner)).toMatchObject({ ok: false });
    expect(await f.human(recordReviewCommand, f.review(created), FIX.owner)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
  it("preserves contribute access for publication, finalization and human review", async () => {
    const f = await fixture();
    await f.grant("contribute");
    const created = await f.create(FIX.owner);
    const consumed = await f.db.withTransaction((tx) =>
      redeemUploadGrant(tx, {
        grantId: created.upload_grant.grant_id,
        secret: created.secret,
        now: NOW,
      }),
    );
    await f.db.withTransaction((tx) =>
      recordVerifiedUpload(tx, {
        grantId: consumed.grantId,
        consumeAttemptId: consumed.consumeAttemptId,
        contentHash: DIGEST,
        size: 26,
        now: NOW,
      }),
    );
    result(
      await f.human(
        finalizeArtifactCommand,
        { versionId: created.version_id, contentHash: DIGEST, size: 26 },
        FIX.owner,
      ),
    );
    result(await f.human(recordReviewCommand, f.review(created), FIX.owner));
    expect(
      await listArtifactReviews(f.db, FIX.workspace, created.artifact_id, f.access()),
    ).toHaveLength(1);
  });
  it("keeps the publication role ceiling even when a reviewer receives edit access", async () => {
    const f = await fixture(),
      created = await f.available();
    await f.grant("edit", FIX.restricted);
    expect(await f.human(createArtifactCommand, f.input(), FIX.restricted)).toMatchObject({
      ok: false,
    });
    result(await f.human(recordReviewCommand, f.review(created), FIX.restricted));
  });
  it("makes omitted human authority shared-only without hiding run-free artifacts", async () => {
    const f = await fixture(),
      privateVersion = await f.available(),
      free = await f.create(FIX.owner, null);
    expect(
      await getArtifactReviewStatus(f.db, FIX.workspace, privateVersion.artifact_id, [
        FIX.projectA,
      ]),
    ).toBeUndefined();
    expect(await listArtifactReviews(f.db, FIX.workspace, privateVersion.artifact_id)).toEqual([]);
    expect(await artifactEvidenceVersionMap(f.db, FIX.workspace)).toEqual(new Map());
    expect(
      (await listArtifactsWithReviewState(f.db, FIX.workspace, [FIX.projectA])).map(
        (row) => row.artifact_id,
      ),
    ).toEqual([free.artifact_id]);
    expect(
      await getArtifactReviewStatus(
        f.db,
        FIX.workspace,
        privateVersion.artifact_id,
        [FIX.projectA],
        f.access(),
      ),
    ).toBeUndefined();
  });
  it.each(["upload", "view"] as const)(
    "rejects %s consumption after task sharing is revoked",
    async (kind) => {
      const f = await fixture(),
        id = await f.grant("contribute");
      const created = kind === "view" ? await f.available() : await f.create(FIX.owner);
      const view = kind === "view" ? await f.view(created.version_id) : undefined;
      await f.revoke(id);
      const before = await f.counts();
      await expect(
        f.db.withTransaction((tx) =>
          kind === "view"
            ? redeemViewGrant(tx, view!)
            : redeemUploadGrant(tx, {
                grantId: created.upload_grant.grant_id,
                secret: created.secret,
                now: NOW,
              }),
        ),
      ).rejects.toThrow();
      expect(await f.counts()).toEqual(before);
    },
  );
  it("refuses upload consume when the current contribute grant becomes read-only at commit", async () => {
    const f = await fixture(),
      grant = await f.grant("contribute"),
      created = await f.create(FIX.owner),
      before = await f.counts(),
      staged = resultStagedD1(f.db, async () => {
        await f.revoke(grant);
        await f.grant("read");
      });
    await expect(
      staged.db.withTransaction((tx) =>
        redeemUploadGrant(tx, {
          grantId: created.upload_grant.grant_id,
          secret: created.secret,
          now: NOW,
        }),
      ),
    ).rejects.toThrow();
    expect(await f.counts()).toEqual(before);
  });
  it.each(["before", "commit", "read_only_commit"] as const)(
    "denies receipt, object registry, source and audit if contribution closes at %s",
    async (timing) => {
      const f = await fixture(),
        grant = await f.grant("contribute"),
        created = await f.create(FIX.owner),
        consumed = await f.consume(created),
        before = await f.counts();
      const close = async () => {
        await f.revoke(grant);
        if (timing === "read_only_commit") await f.grant("read");
      };
      const db = timing === "before" ? f.db : resultStagedD1(f.db, close).db;
      if (timing === "before") await close();
      await expect(
        db.withTransaction((tx) =>
          recordVerifiedUpload(tx, {
            grantId: consumed.grantId,
            consumeAttemptId: consumed.consumeAttemptId,
            contentHash: DIGEST,
            size: 26,
            now: NOW,
          }),
        ),
      ).rejects.toThrow();
      expect(await f.counts()).toEqual(before);
    },
  );
  it("preserves an existing immutable receipt while denying recovery after contribution revoke", async () => {
    const f = await fixture(),
      grant = await f.grant("contribute"),
      created = await f.create(FIX.owner),
      consumed = await f.consume(created),
      input = {
        grantId: consumed.grantId,
        consumeAttemptId: consumed.consumeAttemptId,
        contentHash: DIGEST,
        size: 26,
        now: NOW,
      };
    await f.db.withTransaction((tx) => recordVerifiedUpload(tx, input));
    const before = await f.counts();
    await f.revoke(grant);
    await expect(f.db.withTransaction((tx) => recordVerifiedUpload(tx, input))).rejects.toThrow();
    expect(await f.counts()).toEqual(before);
    expect(
      await f.db.prepare("SELECT COUNT(*) AS total FROM artifact_upload_receipts").get(),
    ).toEqual({ total: 1 });
    expect(
      await f.human(
        finalizeArtifactCommand,
        {
          versionId: created.version_id,
          contentHash: DIGEST,
          size: 26,
        },
        FIX.owner,
      ),
    ).toMatchObject({ ok: false, error: { code: "request_rejected" } });
  });
  it.each(["upload", "view"] as const)(
    "rolls back %s consume, claim and audit when revoke races the D1 batch",
    async (kind) => {
      const f = await fixture(),
        id = await f.grant("contribute");
      const created = kind === "view" ? await f.available() : await f.create(FIX.owner);
      const view = kind === "view" ? await f.view(created.version_id) : undefined;
      const before = await f.counts(),
        staged = resultStagedD1(f.db, async () => {
          await f.revoke(id);
        });
      await expect(
        staged.db.withTransaction((tx) =>
          kind === "view"
            ? redeemViewGrant(tx, view!)
            : redeemUploadGrant(tx, {
                grantId: created.upload_grant.grant_id,
                secret: created.secret,
                now: NOW,
              }),
        ),
      ).rejects.toThrow();
      expect(await f.counts()).toEqual(before);
    },
  );
  it.each(["create", "issue", "finalize", "view_issue", "review"] as const)(
    "rolls back %s when sharing is revoked before commit",
    async (kind) => {
      const f = await fixture(),
        id = await f.grant("contribute"),
        created =
          kind === "review" || kind === "view_issue"
            ? await f.available()
            : kind === "finalize"
              ? await f.verified()
              : await f.create();
      const before = await f.counts(),
        staged = resultStagedD1(f.db, async () => {
          await f.revoke(id);
        }),
        hub = new WorkspaceHub(staged.db);
      const outcome =
        kind === "create"
          ? await f.human(createArtifactCommand, f.input(), FIX.owner, randomUlid(), hub)
          : kind === "issue"
            ? await f.human(
                issueArtifactGrantCommand,
                {
                  versionId: created.version_id,
                  grantSecretHash: mintUploadGrantSecret().secretHash,
                },
                FIX.owner,
                randomUlid(),
                hub,
              )
            : kind === "finalize"
              ? await f.human(
                  finalizeArtifactCommand,
                  { versionId: created.version_id, contentHash: DIGEST, size: 26 },
                  FIX.owner,
                  randomUlid(),
                  hub,
                )
              : kind === "view_issue"
                ? await f.human(
                    createViewGrantCommand,
                    {
                      versionId: created.version_id,
                      grantSecretHash: mintViewGrantSecret().secretHash,
                      viewNonce: mintViewNonce(),
                      sessionHash: artifactHash("synthetic session"),
                    },
                    FIX.owner,
                    randomUlid(),
                    hub,
                  )
                : await f.human(
                    recordReviewCommand,
                    f.review(created),
                    FIX.owner,
                    randomUlid(),
                    hub,
                  );
      expect(outcome).toMatchObject({ ok: false });
      expect(await f.counts()).toEqual(before);
    },
  );
  it("denies cached reviews and changed retries before revealing an original private comment", async () => {
    const f = await fixture(),
      id = await f.grant("contribute"),
      created = await f.available(),
      key = randomUlid(),
      input = f.review(created);
    result(await f.human(recordReviewCommand, input, FIX.owner, key));
    await f.revoke(id);
    for (const retry of [input, { ...input, comment: "Different synthetic note" }])
      expect(await f.human(recordReviewCommand, retry, FIX.owner, key)).toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
    expect(await listArtifactReviews(f.db, FIX.workspace, created.artifact_id, f.access())).toEqual(
      [],
    );
  });
  it("requires independent timer task read authority and hides denied observations like missing ones", async () => {
    const f = await fixture(),
      created = await f.available(),
      timer = await f.privateTimer();
    await f.grant("contribute");
    const before = await f.counts();
    for (const observationId of [timer.observationId, randomUlid()])
      expect(
        await f.human(
          recordReviewCommand,
          { ...f.review(created), reviewTimerObservationId: observationId },
          FIX.owner,
        ),
      ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await readReviewTimerContext(f.db, FIX.workspace, timer.observationId, f.access()),
    ).toBeNull();
    expect(await readReviewTimerContext(f.db, FIX.workspace, timer.observationId)).toBeNull();
    expect(await f.counts()).toEqual(before);
  });
  it("redacts a revoked independent timer relation on list and cached review replies", async () => {
    const f = await fixture(),
      created = await f.available(),
      timer = await f.privateTimer(),
      timerGrant = await f.grant("read", FIX.owner, timer.timerTaskId),
      key = randomUlid(),
      input = { ...f.review(created), reviewTimerObservationId: timer.observationId };
    await f.grant("contribute");
    expect(result(await f.human(recordReviewCommand, input, FIX.owner, key))).toMatchObject({
      review_timer_observation_id: timer.observationId,
    });
    expect(
      await readReviewTimerContext(f.db, FIX.workspace, timer.observationId, f.access()),
    ).toMatchObject({ timer: { id: timer.timerId, task_id: timer.timerTaskId } });
    await f.revoke(timerGrant);
    expect(await f.human(recordReviewCommand, input, FIX.owner, key)).toMatchObject({
      ok: true,
      replayed: true,
      result: { review_timer_observation_id: null, comment: input.comment },
    });
    expect(
      await listArtifactReviews(f.db, FIX.workspace, created.artifact_id, f.access()),
    ).toMatchObject([{ review_timer_observation_id: null }]);
    expect(
      await f.db.prepare("SELECT review_timer_observation_id FROM artifact_reviews").all(),
    ).toEqual([{ review_timer_observation_id: timer.observationId }]);
  });
  it("rolls back a review when only the independent timer grant closes at commit", async () => {
    const f = await fixture(),
      created = await f.available(),
      timer = await f.privateTimer(),
      timerGrant = await f.grant("read", FIX.owner, timer.timerTaskId);
    await f.grant("contribute");
    const before = await f.counts(),
      hub = new WorkspaceHub(resultStagedD1(f.db, () => f.revoke(timerGrant)).db);
    expect(
      await f.human(
        recordReviewCommand,
        { ...f.review(created), reviewTimerObservationId: timer.observationId },
        FIX.owner,
        randomUlid(),
        hub,
      ),
    ).toMatchObject({ ok: false });
    expect(await f.counts()).toEqual(before);
  });
  it("redacts timer IDs when independent revocation interleaves status child assembly", async () => {
    const f = await fixture(),
      created = await f.available(),
      timer = await f.privateTimer(),
      timerGrant = await f.grant("read", FIX.owner, timer.timerTaskId);
    await f.grant("contribute");
    result(
      await f.human(
        recordReviewCommand,
        {
          ...f.review(created),
          reviewTimerObservationId: timer.observationId,
        },
        FIX.owner,
      ),
    );
    let closed = false;
    const readingDb = {
      prepare(sql: string) {
        const statement = f.db.prepare(sql);
        return {
          ...statement,
          async all(...parameters: unknown[]) {
            const rows = await statement.all(...parameters);
            if (!closed && sql.includes("FROM result_submissions AS s")) {
              closed = true;
              await f.revoke(timerGrant);
            }
            return rows;
          },
        };
      },
    };
    expect(
      await getArtifactReviewStatus(
        readingDb,
        FIX.workspace,
        created.artifact_id,
        [FIX.projectA],
        f.access(),
      ),
    ).toMatchObject({ reviews: [{ review_timer_observation_id: null }] });
    expect(closed).toBe(true);
  });
  it("rejects historical timer rows with a mismatched run parent", async () => {
    const f = await fixture(),
      created = await f.available(),
      timer = await f.privateTimer();
    await f.grant("contribute");
    await f.grant("read", FIX.owner, timer.timerTaskId);
    await f.db.prepare("UPDATE review_timers SET run_id=? WHERE id=?").run(f.runId, timer.timerId);
    expect(
      await readReviewTimerContext(f.db, FIX.workspace, timer.observationId, f.access()),
    ).toBeNull();
    expect(
      await f.human(
        recordReviewCommand,
        { ...f.review(created), reviewTimerObservationId: timer.observationId },
        FIX.owner,
      ),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
  it("does not retain an earlier summary when revoke interleaves a later artifact read", async () => {
    const f = await fixture(),
      grant = await f.grant("read");
    await f.available();
    await f.available();
    let counts = 0;
    const readingDb = {
      prepare(sql: string) {
        const statement = f.db.prepare(sql);
        return {
          ...statement,
          async get(...parameters: unknown[]) {
            const row = await statement.get(...parameters);
            if (sql.includes("COUNT(*) AS total FROM artifact_reviews") && ++counts === 2)
              await f.revoke(grant);
            return row;
          },
        };
      },
    };
    expect(
      await listArtifactsWithReviewState(
        readingDb,
        FIX.workspace,
        [FIX.projectA],
        undefined,
        f.access(),
      ),
    ).toEqual([]);
    expect(counts).toBe(2);
  });
  it("keeps unscoped recovery shared-only before its bounded page is selected", async () => {
    const f = await fixture(),
      hidden = await f.create(),
      free = await f.create(FIX.owner, null),
      later = "2026-10-06T12:21:00.000Z";
    vi.setSystemTime(later);
    expect(await listAbandonedArtifactUploads(f.db, later, { limit: 1 })).toEqual([
      { workspace_id: FIX.workspace, id: free.version_id },
    ]);
    const before = await f.counts();
    expect(
      await f.hub.execute(markArtifactFailedCommand, {
        workspaceId: FIX.workspace,
        actorSystemId: ARTIFACT_RECOVERY_SYSTEM_ID,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        input: { versionId: hidden.version_id },
      }),
    ).toMatchObject({ ok: false, error: { code: "request_rejected" } });
    expect(await f.counts()).toEqual(before);
    expect(
      result(
        await f.hub.execute(markArtifactFailedCommand, {
          workspaceId: FIX.workspace,
          actorSystemId: ARTIFACT_RECOVERY_SYSTEM_ID,
          authorizationEpoch: 1,
          idempotencyKey: randomUlid(),
          input: { versionId: free.version_id },
        }),
      ),
    ).toMatchObject({ version_id: free.version_id, state: "failed" });
  });
});

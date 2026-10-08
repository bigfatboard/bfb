// ABOUTME: Proves current public authority for historical child-command replies and committed business effects.
// ABOUTME: Synthetic task, result and artifact fixtures retain canonical history across independent permission cuts.

import { createHash } from "node:crypto";
import type { SqlDatabase } from "@bfb/db";
import { describe, expect, it, vi } from "vitest";

import { recordReviewCommand, type ReviewRecord } from "../src/artifact-reviews.js";
import {
  createViewGrantCommand,
  mintViewGrantSecret,
  mintViewNonce,
  VIEW_GRANT_TTL_MS,
} from "../src/artifact-views.js";
import {
  createArtifactCommand,
  finalizeArtifactCommand,
  issueArtifactGrantCommand,
  mintUploadGrantSecret,
  recordVerifiedUpload,
  redeemUploadGrant,
} from "../src/artifacts.js";
import { bumpMemberEpoch, loadPrincipal } from "../src/authorization.js";
import { FIX } from "../src/fixtures.js";
import {
  WorkspaceHub,
  type CommandOutcome,
  type CommandRequest,
  type HubCommand,
  type HubContext,
} from "../src/hub.js";
import { startReviewTimerCommand } from "../src/measurements.js";
import {
  capturePublicBusinessAuthority,
  finalizePublicBusinessResult,
  ownsPublicBusinessDelivery,
  withPublicBusinessAuthority,
  type PublicBusinessAuthority,
} from "../src/public-business.js";
import { randomUlid } from "../src/ids.js";
import {
  acceptResultCommand,
  cancelRunCommand,
  failRunCommand,
  requestChangesCommand,
  submitResultCommand,
  type ReviewResultInput,
  publicSubmissionBusinessSelection,
} from "../src/results.js";
import { createTaskCommand } from "../src/work-commands.js";
import { createRunCommand } from "../src/work-records.js";
import { openDomainDb } from "./helpers.js";
import { resultFixture, resultStagedD1 } from "./result-fixture.js";
import { LAUNCH_NOW } from "./launch-fixture.js";

const CONTENT = "SYNTHETIC-PUBLIC-CHILD-BUSINESS";
const DIGEST = createHash("sha256").update(CONTENT).digest("hex");

function success<T>(outcome: CommandOutcome<T>): T {
  expect(outcome).toMatchObject({ ok: true });
  if (!outcome.ok) throw new Error(outcome.error.code);
  return outcome.result;
}
async function effects(db: SqlDatabase) {
  const rows: Record<string, unknown[]> = {};
  const tables = (await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  for (const { name } of tables) {
    if (
      name.startsWith("sqlite_") ||
      name.startsWith("_cf") ||
      ["d1_migrations", "rate_limit_buckets"].includes(name)
    )
      continue;
    expect(name).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/u);
    rows[name] = await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
  }
  return rows;
}
async function fixture() {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db);
  async function request<T>(input: T, humanId = FIX.member): Promise<CommandRequest<T>> {
    const principal = await loadPrincipal(db, FIX.workspace, humanId);
    return {
      workspaceId: FIX.workspace,
      actorHumanId: humanId,
      authorizationEpoch: principal.authorizationEpoch,
      idempotencyKey: randomUlid(),
      input,
    };
  }
  const task = success(
      await hub.execute(
        createTaskCommand,
        await request({ projectId: FIX.projectA, title: CONTENT, priority: "P2" as const }),
      ),
    ),
    run = success(
      await hub.execute(
        createRunCommand,
        await request({
          taskId: task.id,
          expectedTaskVersion: 1,
          agentProfileId: FIX.profileCodex,
          workspacePolicyVersion: 1,
          projectPolicyVersion: 1,
          repositoryConfigVersion: 1,
          agentProfileVersion: 1,
        }),
      ),
    ),
    grantId = randomUlid(),
    now = new Date().toISOString();
  // Dormant synthetic privacy/grant; private task creation remains unavailable.
  await db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, task.id, FIX.member, now);
  await db
    .prepare(
      "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'edit',?)",
    )
    .run(FIX.workspace, grantId, task.id, FIX.owner, now);
  async function revoke() {
    const now = new Date().toISOString();
    await db
      .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
      .run(now, FIX.workspace, grantId);
    expect(
      await db.prepare("SELECT revoked_at FROM task_human_grants WHERE id=?").get(grantId),
    ).toEqual({ revoked_at: now });
  }
  async function artifact() {
    const minted = mintUploadGrantSecret(),
      created = success(
        await hub.execute(
          createArtifactCommand,
          await request(
            {
              artifactId: null,
              runId: run.run.id,
              format: "markdown" as const,
              role: "review" as const,
              declaredSize: CONTENT.length,
              expectedDigest: DIGEST,
              grantSecretHash: minted.secretHash,
            },
            FIX.owner,
          ),
        ),
      ),
      now = new Date().toISOString(),
      consumed = await redeemUploadGrant(db, {
        grantId: created.upload_grant.grant_id,
        secret: minted.secret,
        now,
      });
    await db.withTransaction((tx) =>
      recordVerifiedUpload(tx, {
        grantId: consumed.grantId,
        consumeAttemptId: consumed.consumeAttemptId,
        contentHash: DIGEST,
        size: CONTENT.length,
        now,
      }),
    );
    const finalized = success(
      await hub.execute(
        finalizeArtifactCommand,
        await request(
          { versionId: created.version_id, contentHash: DIGEST, size: CONTENT.length },
          FIX.owner,
        ),
      ),
    );
    return { created, finalized };
  }
  return { db, hub, request, task, runId: run.run.id, grantId, revoke, artifact };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function context<T>(f: Fixture, request: CommandRequest<T>, db = f.db): HubContext {
  return {
    db,
    workspaceId: request.workspaceId,
    actorHumanId: request.actorHumanId,
    actorDelegationId: request.actorDelegationId,
    authorizationEpoch: request.authorizationEpoch,
    now: request.now ?? new Date().toISOString(),
    cursorBase: 0,
  };
}
async function publicRequest<T, R>(
  f: Fixture,
  command: HubCommand<T, R>,
  input: T,
  humanId = FIX.owner,
) {
  const request = await f.request(input, humanId),
    ctx = context(f, request),
    authority = await capturePublicBusinessAuthority(f.db, ctx);
  return {
    request: { ...request, input: withPublicBusinessAuthority(command, input, authority) },
    ctx,
    authority,
  };
}
function checkedQueries(db: SqlDatabase) {
  const queries: Array<{ sql: string; parameters: unknown[] }> = [];
  const wrap = (source: SqlDatabase): SqlDatabase => ({
    withTransaction: (callback) => source.withTransaction((tx) => callback(wrap(tx))),
    prepare(sql) {
      const statement = source.prepare(sql);
      function record(parameters: unknown[]) {
        expect(parameters.length).toBeLessThanOrEqual(100);
        expect(Buffer.byteLength(sql)).toBeLessThanOrEqual(100_000);
        queries.push({ sql, parameters });
      }
      return {
        get: (...parameters) => {
          record(parameters);
          return statement.get(...parameters);
        },
        all: (...parameters) => {
          record(parameters);
          return statement.all(...parameters);
        },
        run: (...parameters) => {
          record(parameters);
          return statement.run(...parameters);
        },
      };
    },
  });
  return { db: wrap(db), queries };
}

function cacheCut(f: Fixture, mutation: () => Promise<void>, afterReview = false) {
  let selected = false,
    changed = false,
    baseline: Awaited<ReturnType<typeof effects>> | undefined;
  const wrap = (source: SqlDatabase): SqlDatabase => ({
    withTransaction: (callback) => source.withTransaction((tx) => callback(wrap(tx))),
    prepare(sql) {
      const statement = source.prepare(sql);
      return {
        run: (...args) => statement.run(...args),
        all: (...args) => statement.all(...args),
        get: async (...args) => {
          const row = await statement.get(...args);
          if (sql.includes("FROM idempotency_records") && row != null) selected = true;
          if (
            selected &&
            !changed &&
            (!afterReview || (sql.includes("FROM artifact_reviews AS review") && row != null))
          ) {
            await mutation();
            changed = true;
            baseline = await effects(f.db);
          }
          return row;
        },
      };
    },
  });
  return {
    hub: new WorkspaceHub(wrap(resultStagedD1(f.db).db)),
    assert: async () => {
      expect(selected).toBe(true);
      expect(changed).toBe(true);
      expect(baseline).toBeDefined();
      expect(await effects(f.db)).toEqual(baseline);
    },
  };
}
function denied(outcome: CommandOutcome<unknown>) {
  expect(outcome).toMatchObject({ ok: false, error: { code: "not_found" } });
  expect(JSON.stringify(outcome)).not.toContain(CONTENT);
}

describe("public child business historical delivery", () => {
  it.each(["accept", "request_changes"] as const)(
    "withholds cached result %s after target grant loss",
    async (kind) => {
      const f = await fixture(),
        submitted = success(
          await f.hub.execute(
            submitResultCommand,
            await f.request({ runId: f.runId, summary: CONTENT }),
          ),
        ),
        command = kind === "accept" ? acceptResultCommand : requestChangesCommand,
        request = await f.request<ReviewResultInput>(
          {
            runId: f.runId,
            submissionId: submitted.submission.id,
            expectedRunVersion: submitted.runVersion,
            expectedTaskVersion: submitted.taskVersion,
          },
          FIX.owner,
        );
      success(await f.hub.execute(command, request));
      const cut = cacheCut(f, f.revoke),
        reply = await cut.hub.execute(command, request);
      await cut.assert();
      denied(reply);
    },
  );

  it.each(["fail", "cancel"] as const)(
    "withholds cached run %s after current operation-role loss",
    async (kind) => {
      const f = await fixture(),
        command = kind === "fail" ? failRunCommand : cancelRunCommand,
        request = await f.request({ runId: f.runId, expectedRunVersion: 1 });
      success(await f.hub.execute(command as HubCommand<typeof request.input, unknown>, request));
      const cut = cacheCut(f, async () => {
          await f.db
            .prepare(
              "UPDATE workspace_members SET role='reviewer' WHERE workspace_id=? AND human_id=?",
            )
            .run(FIX.workspace, FIX.member);
          expect((await loadPrincipal(f.db, FIX.workspace, FIX.member)).role).toBe("reviewer");
        }),
        reply = await cut.hub.execute(
          command as HubCommand<typeof request.input, unknown>,
          request,
        );
      await cut.assert();
      denied(reply);
    },
  );

  it("withholds artifact review cached content after its earlier authorized projection loses the parent", async () => {
    const f = await fixture(),
      published = await f.artifact(),
      input = {
        artifactId: published.created.artifact_id,
        versionId: published.created.version_id,
        expectedContentHash: DIGEST,
        expectedLatestVersionId: published.created.version_id,
        decision: "comment" as const,
        comment: CONTENT,
      },
      request = await f.request(input, FIX.owner);
    success(await f.hub.execute(recordReviewCommand, request));
    const cut = cacheCut(f, f.revoke, true),
      reply = await cut.hub.execute(recordReviewCommand, request);
    await cut.assert();
    denied(reply);
  });

  it.each(["accept", "request_changes"] as const)(
    "retains exact historical result %s retry without new state/version checks",
    async (kind) => {
      const f = await fixture(),
        submitted = success(
          await f.hub.execute(
            submitResultCommand,
            await f.request({ runId: f.runId, summary: CONTENT }),
          ),
        ),
        command = kind === "accept" ? acceptResultCommand : requestChangesCommand,
        request = await f.request<ReviewResultInput>(
          {
            runId: f.runId,
            submissionId: submitted.submission.id,
            expectedRunVersion: submitted.runVersion,
            expectedTaskVersion: submitted.taskVersion,
          },
          FIX.owner,
        ),
        original = await f.hub.execute(command, request);
      success(original);
      const before = await effects(f.db),
        reply = await f.hub.execute(command, request);
      expect(reply).toEqual({ ...original, replayed: true });
      expect(await effects(f.db)).toEqual(before);
    },
  );

  it("keeps immutable review history on a healthy exact retry", async () => {
    const f = await fixture(),
      published = await f.artifact(),
      request = await f.request(
        {
          artifactId: published.created.artifact_id,
          versionId: published.created.version_id,
          expectedContentHash: DIGEST,
          expectedLatestVersionId: published.created.version_id,
          decision: "comment" as const,
          comment: CONTENT,
        },
        FIX.owner,
      ),
      original = await f.hub.execute(recordReviewCommand, request);
    const record: ReviewRecord = success(original),
      before = await effects(f.db),
      reply = await f.hub.execute(recordReviewCommand, request);
    expect(success(reply)).toEqual(record);
    expect(reply).toEqual({ ...original, replayed: true });
    expect(await effects(f.db)).toEqual(before);
  });

  it.each(["submit", "accept", "request_changes", "fail", "cancel"] as const)(
    "withholds completed %s delivery after its retained target grant is revoked without undoing effects",
    async (kind) => {
      const f = await fixture();
      let command: HubCommand<any, any>, input: Record<string, unknown>;
      if (kind === "accept" || kind === "request_changes") {
        const submitted = success(
          await f.hub.execute(
            submitResultCommand,
            await f.request({ runId: f.runId, summary: CONTENT }),
          ),
        );
        command = kind === "accept" ? acceptResultCommand : requestChangesCommand;
        input = {
          runId: f.runId,
          submissionId: submitted.submission.id,
          expectedRunVersion: submitted.runVersion,
          expectedTaskVersion: submitted.taskVersion,
        };
      } else {
        command =
          kind === "submit"
            ? submitResultCommand
            : kind === "fail"
              ? failRunCommand
              : cancelRunCommand;
        input =
          kind === "submit"
            ? { runId: f.runId, summary: CONTENT }
            : { runId: f.runId, expectedRunVersion: 1 };
      }
      const retained = await publicRequest(f, command, input),
        result = success(await f.hub.execute(command, retained.request));
      await f.revoke();
      const before = await effects(f.db);
      await expect(
        finalizePublicBusinessResult(command, retained.request.input, result, retained.ctx),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(await effects(f.db)).toEqual(before);
    },
  );

  it.each(["epoch", "project", "role"] as const)(
    "retains the original result authority across late %s loss",
    async (kind) => {
      const f = await fixture(),
        retained = await publicRequest(f, submitResultCommand, {
          runId: f.runId,
          summary: CONTENT,
        }),
        result = success(await f.hub.execute(submitResultCommand, retained.request));
      if (kind === "epoch") await bumpMemberEpoch(f.db, FIX.workspace, FIX.owner);
      else if (kind === "role") {
        await f.db
          .prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND human_id=?")
          .run(FIX.workspace, FIX.member);
        await f.db
          .prepare(
            "UPDATE workspace_members SET role='reviewer' WHERE workspace_id=? AND human_id=?",
          )
          .run(FIX.workspace, FIX.owner);
      } else {
        await f.db
          .prepare("UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id=?")
          .run(FIX.workspace, FIX.projectA);
        await f.db
          .prepare(
            "DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
          )
          .run(FIX.workspace, FIX.projectA, FIX.owner);
      }
      const before = await effects(f.db);
      await expect(
        finalizePublicBusinessResult(
          submitResultCommand,
          retained.request.input,
          result,
          retained.ctx,
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(await effects(f.db)).toEqual(before);
    },
  );

  it("does not adopt a new elevated role after public admission", async () => {
    const f = await fixture(),
      principal = await loadPrincipal(f.db, FIX.workspace, FIX.reviewer),
      input = { runId: f.runId, expectedRunVersion: 1 },
      request = await f.request(input, FIX.reviewer),
      authority = await capturePublicBusinessAuthority(f.db, context(f, request), principal);
    await f.db
      .prepare("UPDATE workspace_members SET role='member' WHERE workspace_id=? AND human_id=?")
      .run(FIX.workspace, FIX.reviewer);
    await f.db
      .prepare(
        "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'edit',?)",
      )
      .run(FIX.workspace, randomUlid(), f.task.id, FIX.reviewer, new Date().toISOString());
    const before = await effects(f.db);
    denied(
      await f.hub.execute(failRunCommand, {
        ...request,
        input: withPublicBusinessAuthority(failRunCommand, input, authority),
      }),
    );
    expect(await effects(f.db)).toEqual(before);
  });

  it("rolls back an entire fresh staged result command after an independent target grant cut", async () => {
    const f = await fixture(),
      retained = await publicRequest(f, submitResultCommand, { runId: f.runId, summary: CONTENT });
    let before: Awaited<ReturnType<typeof effects>> | undefined;
    const staged = resultStagedD1(f.db, async () => {
        await f.revoke();
        before = await effects(f.db);
      }),
      checked = checkedQueries(staged.db),
      reply = await new WorkspaceHub(checked.db).execute(submitResultCommand, retained.request);
    expect(before).toBeDefined();
    expect(await effects(f.db)).toEqual(before);
    expect(reply).toMatchObject({ ok: false, error: { code: "command_failed" } });
    expect(
      checked.queries.filter(({ sql }) => sql.includes("VALUES (?, CASE WHEN EXISTS")),
    ).toHaveLength(1);
  });

  it("checks all recognized evidence together at delivery, not just the target or first reference", async () => {
    const f = await fixture(),
      first = await f.artifact(),
      other = success(
        await f.hub.execute(
          createTaskCommand,
          await f.request({
            projectId: FIX.projectA,
            title: "Synthetic shared evidence parent",
            priority: "P2" as const,
          }),
        ),
      ),
      otherRun = success(
        await f.hub.execute(
          createRunCommand,
          await f.request({
            taskId: other.id,
            expectedTaskVersion: 1,
            agentProfileId: FIX.profileCodex,
            workspacePolicyVersion: 1,
            projectPolicyVersion: 1,
            repositoryConfigVersion: 1,
            agentProfileVersion: 1,
          }),
        ),
      ),
      minted = mintUploadGrantSecret(),
      second = success(
        await f.hub.execute(
          createArtifactCommand,
          await f.request({
            artifactId: null,
            runId: otherRun.run.id,
            format: "markdown" as const,
            role: "review" as const,
            declaredSize: CONTENT.length,
            expectedDigest: DIGEST,
            grantSecretHash: minted.secretHash,
          }),
        ),
      ),
      retained = await publicRequest(f, submitResultCommand, {
        runId: f.runId,
        summary: CONTENT,
        evidenceRefs: [
          {
            kind: "artifact_version",
            ref: first.created.artifact_id,
            version: first.created.version_id,
          },
          { kind: "artifact_version", ref: second.version_id },
        ],
      }),
      result = success(await f.hub.execute(submitResultCommand, retained.request));
    await f.db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, other.id, FIX.member, new Date().toISOString());
    const before = await effects(f.db),
      checked = checkedQueries(f.db);
    await expect(
      finalizePublicBusinessResult(submitResultCommand, retained.request.input, result, {
        ...retained.ctx,
        db: checked.db,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(checked.queries).toHaveLength(1);
    expect(await effects(f.db)).toEqual(before);
  });

  it("masks an independently hidden timer in the same selector that delivers immutable artifact review history", async () => {
    const f = await fixture(),
      published = await f.artifact(),
      task = success(
        await f.hub.execute(
          createTaskCommand,
          await f.request({
            projectId: FIX.projectA,
            title: "Synthetic timer parent",
            priority: "P2" as const,
          }),
        ),
      ),
      timer = success(
        await f.hub.execute(
          startReviewTimerCommand,
          await f.request({ taskId: task.id }, FIX.owner),
        ),
      ),
      observation = (await f.db
        .prepare(
          "SELECT observation_id FROM review_timer_observations WHERE workspace_id=? AND timer_id=?",
        )
        .get(FIX.workspace, timer.id)) as { observation_id: string },
      retained = await publicRequest(f, recordReviewCommand, {
        artifactId: published.created.artifact_id,
        versionId: published.created.version_id,
        expectedContentHash: DIGEST,
        expectedLatestVersionId: published.created.version_id,
        decision: "comment" as const,
        comment: CONTENT,
        reviewTimerObservationId: observation.observation_id,
      }),
      result = success(await f.hub.execute(recordReviewCommand, retained.request));
    expect(result.review_timer_observation_id).toBe(observation.observation_id);
    await f.db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, task.id, FIX.member, new Date().toISOString());
    const before = await effects(f.db),
      checked = checkedQueries(f.db),
      reply = await finalizePublicBusinessResult(
        recordReviewCommand,
        retained.request.input,
        result,
        { ...retained.ctx, db: checked.db },
      );
    expect(reply).toEqual({ ...result, review_timer_observation_id: null });
    expect(checked.queries).toHaveLength(1);
    expect(await effects(f.db)).toEqual(before);
  });

  it("keeps view issuance on its original observed clock and retains one-use replay rejection", async () => {
    const f = await fixture(),
      published = await f.artifact(),
      minted = mintViewGrantSecret(),
      input = {
        versionId: published.created.version_id,
        grantSecretHash: minted.secretHash,
        viewNonce: mintViewNonce(),
        sessionHash: DIGEST,
      },
      request = { ...(await f.request(input, FIX.owner)), now: "2025-01-01T00:00:00.000Z" },
      result = success(await f.hub.execute(createViewGrantCommand, request));
    expect(createViewGrantCommand.authorize).toBeUndefined();
    expect(Date.parse(result.expires_at) - Date.parse(request.now)).toBe(VIEW_GRANT_TTL_MS);
    const before = await effects(f.db);
    expect(await f.hub.execute(createViewGrantCommand, request)).toMatchObject({
      ok: false,
      error: { code: "request_rejected" },
    });
    expect(await effects(f.db)).toEqual(before);
  });

  it("retains the view request envelope for an absent required version before any SQL binding", async () => {
    const f = await fixture(),
      input = {
        versionId: undefined as unknown as string,
        grantSecretHash: mintViewGrantSecret().secretHash,
        viewNonce: mintViewNonce(),
        sessionHash: DIGEST,
      },
      before = await effects(f.db);
    expect(
      await f.hub.execute(createViewGrantCommand, await f.request(input, FIX.owner)),
    ).toMatchObject({
      ok: false,
      error: { code: "request_rejected", message: "request rejected" },
    });
    expect(await effects(f.db)).toEqual(before);
  });

  it.each(["create", "grant", "finalize", "view", "review"] as const)(
    "delivers canonical artifact %s facts only while the retained parent remains accessible",
    async (kind) => {
      const f = await fixture(),
        published = await f.artifact();
      let command: HubCommand<any, any>, input: Record<string, unknown>, result: unknown;
      if (kind === "create") {
        command = createArtifactCommand;
        input = {
          artifactId: null,
          runId: f.runId,
          format: "markdown",
          role: "review",
          declaredSize: CONTENT.length,
          expectedDigest: DIGEST,
          grantSecretHash: published.created.upload_grant.grant_hash,
        };
        result = published.created;
      } else if (kind === "finalize") {
        command = finalizeArtifactCommand;
        input = {
          versionId: published.created.version_id,
          contentHash: DIGEST,
          size: CONTENT.length,
        };
        result = published.finalized;
      } else if (kind === "grant") {
        command = issueArtifactGrantCommand;
        const mint = mintUploadGrantSecret(),
          version = success(
            await f.hub.execute(
              createArtifactCommand,
              await f.request(
                {
                  artifactId: null,
                  runId: f.runId,
                  format: "markdown" as const,
                  role: "review" as const,
                  declaredSize: CONTENT.length,
                  expectedDigest: DIGEST,
                  grantSecretHash: mint.secretHash,
                },
                FIX.owner,
              ),
            ),
          );
        input = {
          versionId: version.version_id,
          grantSecretHash: mintUploadGrantSecret().secretHash,
        };
      } else if (kind === "view") {
        command = createViewGrantCommand;
        input = {
          versionId: published.created.version_id,
          grantSecretHash: mintViewGrantSecret().secretHash,
          viewNonce: mintViewNonce(),
          sessionHash: DIGEST,
        };
      } else {
        command = recordReviewCommand;
        input = {
          artifactId: published.created.artifact_id,
          versionId: published.created.version_id,
          expectedContentHash: DIGEST,
          expectedLatestVersionId: published.created.version_id,
          decision: "comment",
          comment: CONTENT,
        };
      }
      const retained = await publicRequest(f, command, input);
      if (result === undefined) result = success(await f.hub.execute(command, retained.request));
      const healthy = await effects(f.db);
      expect(
        await finalizePublicBusinessResult(command, retained.request.input, result, retained.ctx),
      ).toEqual(result);
      expect(await effects(f.db)).toEqual(healthy);
      await f.revoke();
      const before = await effects(f.db);
      await expect(
        finalizePublicBusinessResult(command, retained.request.input, result, retained.ctx),
      ).rejects.toMatchObject({ code: kind === "view" ? "request_rejected" : "not_found" });
      expect(await effects(f.db)).toEqual(before);
    },
  );

  it("never injects public authority or factory guards into the real local-agent submission branch", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(LAUNCH_NOW));
    try {
      const f = await resultFixture(),
        request = f.request(),
        input = { principal: f.principal, request },
        authority: PublicBusinessAuthority = {
          ...(await loadPrincipal(f.db, FIX.workspace, FIX.owner)),
        },
        checked = checkedQueries(f.db);
      expect(ownsPublicBusinessDelivery(submitResultCommand, input)).toBe(false);
      expect(withPublicBusinessAuthority(submitResultCommand, input, authority)).toBe(input);
      const result = success(
        await new WorkspaceHub(checked.db).execute(submitResultCommand, {
          workspaceId: FIX.workspace,
          actorRunnerId: f.runner,
          authorizationEpoch: f.principal.authorizationEpoch,
          idempotencyKey: randomUlid(),
          input,
        }),
      );
      expect(result.submission.submitted_by_kind).toBe("agent_run");
      expect(
        checked.queries.filter(({ sql }) => sql.includes("VALUES (?, CASE WHEN EXISTS")),
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps retained authority and synthetic prose out of metadata-only receipts", async () => {
    const f = await fixture(),
      retained = await publicRequest(f, submitResultCommand, { runId: f.runId, summary: CONTENT });
    success(await f.hub.execute(submitResultCommand, retained.request));
    const metadata = JSON.stringify({
      audit: await f.db
        .prepare("SELECT payload_json FROM audit_events WHERE action='result.submit'")
        .all(),
      semantic: await f.db
        .prepare("SELECT payload_json FROM semantic_events WHERE kind='result.submit'")
        .all(),
      outbox: await f.db.prepare("SELECT payload_json FROM artifact_audit_outbox").all(),
    });
    expect(metadata).not.toContain("publicAuthority");
    expect(metadata).not.toContain(CONTENT);
    const stored = (await f.db
      .prepare("SELECT result_json FROM idempotency_records WHERE idempotency_key=?")
      .get(retained.request.idempotencyKey)) as { result_json: string };
    expect(stored.result_json).not.toContain("publicAuthority");
  });

  it.each(["cli", "delegation_bound", "delegation_unbound"] as const)(
    "bounds complete %s evidence and review final selectors",
    async (kind) => {
      const f = await fixture(),
        published = await f.artifact(),
        submitted = success(
          await f.hub.execute(
            submitResultCommand,
            await f.request({ runId: f.runId, summary: CONTENT }),
          ),
        ),
        reviewInput = {
          artifactId: published.created.artifact_id,
          versionId: published.created.version_id,
          expectedContentHash: DIGEST,
          expectedLatestVersionId: published.created.version_id,
          decision: "comment" as const,
          comment: CONTENT,
        },
        reviewed = success(
          await f.hub.execute(recordReviewCommand, await f.request(reviewInput, FIX.owner)),
        ),
        principal = await loadPrincipal(f.db, FIX.workspace, FIX.owner),
        authority: PublicBusinessAuthority = {
          ...principal,
          credential:
            kind === "cli"
              ? { kind, bindingId: randomUlid(), scopes: ["bfb:read", "bfb:task:write"] }
              : {
                  kind: "delegation",
                  delegationId: randomUlid(),
                  clientId: FIX.client,
                  projectId: kind === "delegation_bound" ? FIX.projectA : null,
                  taskId: kind === "delegation_bound" ? f.task.id : null,
                  scopes: ["bfb:read", "bfb:task:write"],
                },
        },
        selection = publicSubmissionBusinessSelection(
          authority,
          f.runId,
          submitted.submission.id,
          ["owner", "member"],
          submitted.submission,
        );
      expect(selection.parameters.length + 1).toBeLessThanOrEqual(100);
      expect(Buffer.byteLength(selection.sql)).toBeLessThanOrEqual(100_000);
      // This capacity control intentionally has no active credential row; it measures
      // the complete registered selector, not credential admission or transport ingress.
      const checked = checkedQueries(f.db),
        ctx = context(f, await f.request(reviewInput, FIX.owner), checked.db);
      if (authority.credential?.kind === "delegation")
        ctx.actorDelegationId = authority.credential.delegationId;
      await expect(
        finalizePublicBusinessResult(
          recordReviewCommand,
          withPublicBusinessAuthority(recordReviewCommand, reviewInput, authority),
          reviewed,
          ctx,
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(checked.queries).toHaveLength(1);
      expect(checked.queries[0]!.parameters.length + 1).toBeLessThanOrEqual(100);
      console.info(
        JSON.stringify({
          stage: "public_child_business_bounds",
          credential: kind,
          evidenceBindings: selection.parameters.length + 1,
          evidenceSqlBytes: Buffer.byteLength(selection.sql),
          reviewBindings: checked.queries[0]!.parameters.length + 1,
          reviewSqlBytes: Buffer.byteLength(checked.queries[0]!.sql),
        }),
      );
    },
  );
});

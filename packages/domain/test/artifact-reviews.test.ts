// ABOUTME: Proves V03 immutable review binding, history, conflicts, and authority limits.
// ABOUTME: Synthetic versions and timers only; approval never touches runs, tasks, or results.

import { createHash } from "node:crypto";

import type { SqlDatabase } from "@bfb/db";
import { describe, expect, it } from "vitest";

import {
  artifactEvidenceVersionMap,
  getArtifactReviewStatus,
  listArtifactReviews,
  listLinkedSubmissions,
  recordReviewCommand,
  type ReviewRecord,
} from "../src/artifact-reviews.js";
import {
  createArtifactCommand,
  finalizeArtifactCommand,
  mintUploadGrantSecret,
  recordVerifiedUpload,
  redeemUploadGrant,
} from "../src/artifacts.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub, type CommandOutcome, type HubCommand } from "../src/hub.js";
import { randomUlid, syntheticUlid } from "../src/ids.js";
import {
  listReviewTimerObservations,
  listReviewTimers,
  startReviewTimerCommand,
} from "../src/measurements.js";
import {
  acceptResultCommand,
  listResultSubmissions,
  submitResultCommand,
} from "../src/results.js";
import { createTaskCommand } from "../src/work-commands.js";
import { createRunCommand } from "../src/work-records.js";
import { openDomainDb } from "./helpers.js";

const NOW = "2026-09-17T12:00:00.000Z";
const LATER = "2026-09-17T13:00:00.000Z";
const COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);

function digest(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function result<T>(outcome: CommandOutcome<T>): T {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  if (!outcome.ok) throw new Error(outcome.error.code);
  return outcome.result;
}

async function failure(promise: Promise<CommandOutcome<unknown>>): Promise<string> {
  const outcome = await promise;
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("expected failure");
  return outcome.error.code;
}

async function fixture() {
  const db = await openDomainDb();
  const hub = new WorkspaceHub(db);
  function human<T, R>(
    command: HubCommand<T, R>,
    input: T,
    overrides: {
      humanId?: string;
      epoch?: number;
      now?: string;
      key?: string;
      delegationId?: string;
      runnerId?: string;
      systemId?: string;
    } = {},
  ) {
    return hub.execute(command, {
      workspaceId: FIX.workspace,
      actorHumanId: overrides.runnerId || overrides.systemId ? undefined : (overrides.humanId ?? FIX.owner),
      actorRunnerId: overrides.runnerId,
      actorSystemId: overrides.systemId,
      actorDelegationId: overrides.delegationId,
      authorizationEpoch: overrides.epoch ?? 1,
      now: overrides.now ?? NOW,
      idempotencyKey: overrides.key ?? randomUlid(),
      input,
    });
  }
  async function taskAndRun(projectId = FIX.projectA): Promise<{ taskId: string; runId: string }> {
    const task = result(
      await human(createTaskCommand, {
        projectId,
        title: "Synthetic review task",
        priority: "P1" as const,
      }),
    );
    const run = result(
      await human(createRunCommand, {
        taskId: task.id,
        expectedTaskVersion: 1,
        agentProfileId: FIX.profileCodex,
        workspacePolicyVersion: 1,
        projectPolicyVersion: 1,
        repositoryConfigVersion: 1,
        agentProfileVersion: 1,
      }),
    );
    return { taskId: task.id, runId: run.run.id };
  }
  async function available(
    label: string,
    runId: string | null = null,
    now: string = NOW,
  ): Promise<{ artifact_id: string; version_id: string; content_hash: string }> {
    const contentHash = digest(label);
    const minted = mintUploadGrantSecret();
    const created = result(
      await human(
        createArtifactCommand,
        {
          artifactId: null,
          runId,
          format: "markdown" as never,
          role: "review" as never,
          declaredSize: 32,
          expectedDigest: contentHash,
          grantSecretHash: minted.secretHash,
        },
        { now },
      ),
    );
    await redeemUploadGrant(db, {
      grantId: created.upload_grant.grant_id,
      secret: minted.secret,
      now,
    });
    await recordVerifiedUpload(db, {
      workspaceId: FIX.workspace,
      versionId: created.version_id,
      runId,
      role: "review",
      contentHash,
      r2Key: `workspaces/${FIX.workspace}/artifacts/sha256/${contentHash}`,
      size: 32,
      now,
    });
    result(
      await human(
        finalizeArtifactCommand,
        { versionId: created.version_id, contentHash, size: 32 },
        { now },
      ),
    );
    return {
      artifact_id: created.artifact_id,
      version_id: created.version_id,
      content_hash: contentHash,
    };
  }
  async function publishNewVersion(
    artifactId: string,
    label: string,
    runId: string | null = null,
    now: string = LATER,
  ): Promise<{ version_id: string; content_hash: string }> {
    const contentHash = digest(label);
    const minted = mintUploadGrantSecret();
    const created = result(
      await human(
        createArtifactCommand,
        {
          artifactId,
          runId,
          format: "markdown" as never,
          role: "review" as never,
          declaredSize: 32,
          expectedDigest: contentHash,
          grantSecretHash: minted.secretHash,
        },
        { now },
      ),
    );
    await redeemUploadGrant(db, {
      grantId: created.upload_grant.grant_id,
      secret: minted.secret,
      now,
    });
    await recordVerifiedUpload(db, {
      workspaceId: FIX.workspace,
      versionId: created.version_id,
      runId,
      role: "review",
      contentHash,
      r2Key: `workspaces/${FIX.workspace}/artifacts/sha256/${contentHash}`,
      size: 32,
      now,
    });
    result(
      await human(
        finalizeArtifactCommand,
        { versionId: created.version_id, contentHash, size: 32 },
        { now },
      ),
    );
    return { version_id: created.version_id, content_hash: contentHash };
  }
  function review(
    input: Record<string, unknown>,
    overrides: Parameters<typeof human>[2] = {},
  ): Promise<CommandOutcome<ReviewRecord>> {
    return human(recordReviewCommand, input as never, overrides) as Promise<
      CommandOutcome<ReviewRecord>
    >;
  }
  return { db, hub, human, taskAndRun, available, publishNewVersion, review };
}

async function tableCounts(db: SqlDatabase): Promise<Record<string, number>> {
  const tables = [
    "runs",
    "tasks",
    "result_submissions",
    "result_reviews",
    "artifact_versions",
    "review_timers",
    "review_timer_observations",
    "browser_activity_observations",
    "launch_commands",
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const row = (await db
      .prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE workspace_id = ?`)
      .get(FIX.workspace)) as { total: number };
    counts[table] = row.total;
  }
  return counts;
}

describe("artifact reviews", () => {
  it("records an approve review bound to the exact version and hash", async () => {
    const f = await fixture();
    const version = await f.available("v03-exact");
    const before = (await f.db
      .prepare(`SELECT * FROM artifact_versions WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, version.version_id)) as Record<string, unknown>;
    const record = result(
      await f.review({
        artifactId: version.artifact_id,
        versionId: version.version_id,
        expectedContentHash: version.content_hash,
        expectedLatestVersionId: version.version_id,
        decision: "approve",
        comment: "Synthetic approval of exact bytes",
      }),
    );
    expect(record.artifact_id).toBe(version.artifact_id);
    expect(record.version_id).toBe(version.version_id);
    expect(record.content_hash).toBe(version.content_hash);
    expect(record.decision).toBe("approve");
    expect(record.reviewer_human_id).toBe(FIX.owner);
    const after = (await f.db
      .prepare(`SELECT * FROM artifact_versions WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, version.version_id)) as Record<string, unknown>;
    expect(after).toEqual(before);
    const status = await getArtifactReviewStatus(f.db, FIX.workspace, version.artifact_id);
    expect(status?.approved).toBe(true);
    expect(status?.changes_requested).toBe(false);
    expect(status?.review_count).toBe(1);
    expect(status?.historical_count).toBe(0);
  });

  it("rejects hash mismatches and non-available versions", async () => {
    const f = await fixture();
    const version = await f.available("v03-mismatch");
    expect(
      await failure(
        f.review({
          artifactId: version.artifact_id,
          versionId: version.version_id,
          expectedContentHash: digest("v03-other-bytes"),
          expectedLatestVersionId: version.version_id,
          decision: "approve",
        }),
      ),
    ).toBe("version_mismatch");
    expect(
      await failure(
        f.review({
          artifactId: version.artifact_id,
          versionId: randomUlid(),
          expectedContentHash: version.content_hash,
          expectedLatestVersionId: version.version_id,
          decision: "approve",
        }),
      ),
    ).toBe("not_found");
    expect(
      await failure(
        f.review({
          artifactId: randomUlid(),
          versionId: version.version_id,
          expectedContentHash: version.content_hash,
          expectedLatestVersionId: version.version_id,
          decision: "approve",
        }),
      ),
    ).toBe("not_found");
  });

  it("keeps prior reviews historical and the new version unapproved", async () => {
    const f = await fixture();
    const first = await f.available("v03-history-v1");
    result(
      await f.review({
        artifactId: first.artifact_id,
        versionId: first.version_id,
        expectedContentHash: first.content_hash,
        expectedLatestVersionId: first.version_id,
        decision: "approve",
      }),
    );
    const second = await f.publishNewVersion(first.artifact_id, "v03-history-v2");
    // The old version id is no longer latest: reviewing it is stale.
    expect(
      await failure(
        f.review({
          artifactId: first.artifact_id,
          versionId: first.version_id,
          expectedContentHash: first.content_hash,
          expectedLatestVersionId: first.version_id,
          decision: "comment",
          comment: "late note on history",
        }),
      ),
    ).toBe("stale_version");
    const status = await getArtifactReviewStatus(f.db, FIX.workspace, first.artifact_id);
    expect(status?.approved).toBe(false);
    expect(status?.review_count).toBe(1);
    expect(status?.historical_count).toBe(1);
    expect(status?.latest_version?.id).toBe(second.version_id);
    const reviews = await listArtifactReviews(f.db, FIX.workspace, first.artifact_id);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.historical).toBe(true);
    expect(reviews[0]?.outdated).toBe(true);
    expect(reviews[0]?.outdated_reasons).toContain("newer_version");
    // Approving the new version restores approval without rewriting history.
    result(
      await f.review({
        artifactId: first.artifact_id,
        versionId: second.version_id,
        expectedContentHash: second.content_hash,
        expectedLatestVersionId: second.version_id,
        decision: "approve",
      }),
    );
    const current = await getArtifactReviewStatus(f.db, FIX.workspace, first.artifact_id);
    expect(current?.approved).toBe(true);
    expect(current?.review_count).toBe(2);
    expect(current?.historical_count).toBe(1);
  });

  it("resolves concurrent review state through explicit version conflict", async () => {
    const f = await fixture();
    const version = await f.available("v03-conflict");
    // The reviewer loaded the page, then a newer version published elsewhere.
    await f.publishNewVersion(version.artifact_id, "v03-conflict-v2");
    expect(
      await failure(
        f.review({
          artifactId: version.artifact_id,
          versionId: version.version_id,
          expectedContentHash: version.content_hash,
          expectedLatestVersionId: version.version_id,
          decision: "approve",
        }),
      ),
    ).toBe("stale_version");
    // Two reviewers may still record different decisions on the same latest
    // version; both stay in history with no lost update.
    const latest = await getArtifactReviewStatus(f.db, FIX.workspace, version.artifact_id);
    const latestId = latest?.latest_version?.id;
    if (!latestId) throw new Error("missing latest version");
    const hash = latest.latest_version?.content_hash;
    if (!hash) throw new Error("missing latest hash");
    result(
      await f.review(
        {
          artifactId: version.artifact_id,
          versionId: latestId,
          expectedContentHash: hash,
          expectedLatestVersionId: latestId,
          decision: "approve",
        },
        { humanId: FIX.owner, key: randomUlid() },
      ),
    );
    result(
      await f.review(
        {
          artifactId: version.artifact_id,
          versionId: latestId,
          expectedContentHash: hash,
          expectedLatestVersionId: latestId,
          decision: "request_changes",
          comment: "Synthetic competing decision",
        },
        { humanId: FIX.member, key: randomUlid() },
      ),
    );
    const settled = await getArtifactReviewStatus(f.db, FIX.workspace, version.artifact_id);
    expect(settled?.approved).toBe(true);
    expect(settled?.changes_requested).toBe(true);
    expect(settled?.review_count).toBe(2);
  });

  it("grants no result, launch, policy, or credential authority from approval", async () => {
    const f = await fixture();
    const { runId, taskId } = await f.taskAndRun();
    const version = await f.available("v03-authority", runId);
    const runBefore = (await f.db
      .prepare(`SELECT result_state, resource_version FROM runs WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, runId)) as Record<string, unknown>;
    const taskBefore = (await f.db
      .prepare(`SELECT state, resource_version FROM tasks WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, taskId)) as Record<string, unknown>;
    const countsBefore = await tableCounts(f.db);
    result(
      await f.review(
        {
          artifactId: version.artifact_id,
          versionId: version.version_id,
          expectedContentHash: version.content_hash,
          expectedLatestVersionId: version.version_id,
          decision: "approve",
        },
        { humanId: FIX.restricted },
      ),
    );
    const runAfter = (await f.db
      .prepare(`SELECT result_state, resource_version FROM runs WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, runId)) as Record<string, unknown>;
    const taskAfter = (await f.db
      .prepare(`SELECT state, resource_version FROM tasks WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, taskId)) as Record<string, unknown>;
    expect(runAfter).toEqual(runBefore);
    expect(taskAfter).toEqual(taskBefore);
    const countsAfter = await tableCounts(f.db);
    expect(countsAfter).toEqual(countsBefore);
    // The approving reviewer still cannot accept the run result: artifact
    // approval is an ordinary review, not result acceptance.
    expect(
      await failure(
        f.human(
          acceptResultCommand,
          {
            runId,
            submissionId: randomUlid(),
            expectedRunVersion: Number(runBefore.resource_version),
            expectedTaskVersion: Number(taskBefore.resource_version),
          },
          { humanId: FIX.restricted },
        ),
      ),
    ).toBe("forbidden");
  });

  it("enforces reviewer project scoping and rejects non-human actors", async () => {
    const f = await fixture();
    const scoped = await f.taskAndRun(FIX.projectA);
    const scopedVersion = await f.available("v03-scope-a", scoped.runId);
    // Reviewer holds a projectA grant in fixtures.
    result(
      await f.review(
        {
          artifactId: scopedVersion.artifact_id,
          versionId: scopedVersion.version_id,
          expectedContentHash: scopedVersion.content_hash,
          expectedLatestVersionId: scopedVersion.version_id,
          decision: "comment",
          comment: "Synthetic scoped comment",
        },
        { humanId: FIX.restricted },
      ),
    );
    const unscoped = await f.taskAndRun(FIX.projectB);
    const unscopedVersion = await f.available("v03-scope-b", unscoped.runId);
    const input = {
      artifactId: unscopedVersion.artifact_id,
      versionId: unscopedVersion.version_id,
      expectedContentHash: unscopedVersion.content_hash,
      expectedLatestVersionId: unscopedVersion.version_id,
      decision: "approve" as const,
    };
    expect(await failure(f.review(input, { humanId: FIX.restricted }))).toBe("forbidden");
    expect(await failure(f.review(input, { runnerId: randomUlid() }))).toBe("forbidden");
    expect(
      await failure(f.review(input, { humanId: FIX.owner, delegationId: randomUlid() })),
    ).toBe("forbidden");
    expect(await failure(f.review(input, { systemId: syntheticUlid("SYSSYN") }))).toBe(
      "forbidden",
    );
    // Epoch mismatch fails closed as well.
    expect(await failure(f.review(input, { epoch: 2 }))).toBe("stale_authorization");
  });

  it("links an A04 timer observation without owning timer state", async () => {
    const f = await fixture();
    const { taskId, runId } = await f.taskAndRun();
    const version = await f.available("v03-timer", runId);
    const timer = result(await f.human(startReviewTimerCommand, { taskId }));
    const observations = await listReviewTimerObservations(f.db, FIX.workspace, timer.id);
    expect(observations.length).toBeGreaterThan(0);
    const observationId = observations[0]?.observation_id;
    if (!observationId) throw new Error("missing timer observation");
    const timersBefore = await listReviewTimers(f.db, FIX.workspace, taskId);
    result(
      await f.review({
        artifactId: version.artifact_id,
        versionId: version.version_id,
        expectedContentHash: version.content_hash,
        expectedLatestVersionId: version.version_id,
        decision: "approve",
        reviewTimerObservationId: observationId,
      }),
    );
    const timersAfter = await listReviewTimers(f.db, FIX.workspace, taskId);
    expect(timersAfter).toEqual(timersBefore);
    // V03 reads durations from A04 observations; it stores no timer of its own.
    expect(await listReviewTimerObservations(f.db, FIX.workspace, timer.id)).toHaveLength(
      observations.length,
    );
    expect(
      await failure(
        f.review({
          artifactId: version.artifact_id,
          versionId: version.version_id,
          expectedContentHash: version.content_hash,
          expectedLatestVersionId: version.version_id,
          decision: "comment",
          comment: "bad observation link",
          reviewTimerObservationId: randomUlid(),
        }),
      ),
    ).toBe("not_found");
  });

  it("flags config and git drift without mutating history", async () => {
    const f = await fixture();
    const { runId } = await f.taskAndRun();
    const version = await f.available("v03-drift", runId);
    const snapshot = (await f.db
      .prepare(
        `SELECT * FROM run_configuration_snapshots WHERE workspace_id = ? AND run_id = ?
         ORDER BY snapshot_generation DESC LIMIT 1`,
      )
      .get(FIX.workspace, runId)) as Record<string, unknown>;
    result(
      await f.review({
        artifactId: version.artifact_id,
        versionId: version.version_id,
        expectedContentHash: version.content_hash,
        expectedLatestVersionId: version.version_id,
        decision: "approve",
        gitCommit: COMMIT,
        configHash: snapshot.content_hash as string,
      }),
    );
    let reviews = await listArtifactReviews(f.db, FIX.workspace, version.artifact_id);
    expect(reviews[0]?.outdated).toBe(false);
    // A newer configuration snapshot marks the review's config binding stale.
    await f.db
      .prepare(
        `INSERT INTO run_configuration_snapshots
         (workspace_id, id, project_id, run_id, workspace_policy_version, project_policy_version,
          repository_config_version, agent_profile_id, agent_profile_version,
          canonical_json, content_hash, created_at, snapshot_generation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        FIX.workspace,
        randomUlid(),
        snapshot.project_id,
        runId,
        snapshot.workspace_policy_version,
        snapshot.project_policy_version,
        snapshot.repository_config_version,
        snapshot.agent_profile_id,
        snapshot.agent_profile_version,
        snapshot.canonical_json,
        `sha256:${"d".repeat(64)}`,
        LATER,
        Number(snapshot.snapshot_generation) + 1,
      );
    // A newer submission with different git facts marks the git binding stale.
    result(
      await f.human(submitResultCommand, {
        runId,
        summary: "Synthetic drift submission",
        gitBranch: "main",
        gitCommit: OTHER_COMMIT,
        gitDirty: false,
      }),
    );
    reviews = await listArtifactReviews(f.db, FIX.workspace, version.artifact_id);
    expect(reviews[0]?.outdated).toBe(true);
    expect(reviews[0]?.outdated_reasons).toContain("config_changed");
    expect(reviews[0]?.outdated_reasons).toContain("git_changed");
    expect(reviews).toHaveLength(1);
  });

  it("links submissions that bind the artifact without accepting them", async () => {
    const f = await fixture();
    const { runId } = await f.taskAndRun();
    const version = await f.available("v03-link", runId);
    result(
      await f.human(submitResultCommand, {
        runId,
        summary: "Synthetic linked submission",
        evidenceRefs: [
          {
            kind: "artifact_version",
            ref: version.artifact_id,
            version: version.version_id,
            hash: `sha256:${version.content_hash}`,
          },
        ],
      }),
    );
    let linked = await listLinkedSubmissions(f.db, FIX.workspace, version.artifact_id, version.version_id);
    expect(linked).toHaveLength(1);
    expect(linked[0]?.references_current_version).toBe(true);
    expect(linked[0]?.result_state).toBe("submitted");
    const second = await f.publishNewVersion(version.artifact_id, "v03-link-v2", runId);
    linked = await listLinkedSubmissions(f.db, FIX.workspace, version.artifact_id, second.version_id);
    expect(linked).toHaveLength(1);
    expect(linked[0]?.references_current_version).toBe(false);
    // The A03 evidence map marks the bound submission outdated on read.
    const map = await artifactEvidenceVersionMap(f.db, FIX.workspace);
    expect(map.get(`artifact_version\n${version.artifact_id}`)).toBe(second.version_id);
    const submissions = await listResultSubmissions(f.db, FIX.workspace, runId, map);
    expect(submissions[0]?.outdated).toBe(true);
    expect(submissions[0]?.outdated_reasons).toContain("evidence_changed");
  });

  it("stores hostile comments verbatim for escaped rendering and audits without secrets", async () => {
    const f = await fixture();
    const version = await f.available("v03-hostile");
    const hostile = `</script><script>alert(document.cookie)</script><img src=x onerror=alert(1)>`;
    const record = result(
      await f.review({
        artifactId: version.artifact_id,
        versionId: version.version_id,
        expectedContentHash: version.content_hash,
        expectedLatestVersionId: version.version_id,
        decision: "comment",
        comment: hostile,
      }),
    );
    expect(record.comment).toBe(hostile);
    const reviews = await listArtifactReviews(f.db, FIX.workspace, version.artifact_id);
    expect(reviews[0]?.comment).toBe(hostile);
    const audits = (await f.db
      .prepare(
        `SELECT action, payload_json FROM artifact_audit_outbox
         WHERE workspace_id = ? AND version_id = ? ORDER BY created_at ASC`,
      )
      .all(FIX.workspace, version.version_id)) as Array<{
      action: string;
      payload_json: string;
    }>;
    const recorded = audits.filter((audit) => audit.action === "artifact.review_recorded");
    expect(recorded).toHaveLength(1);
    const payload = JSON.parse(recorded[0]?.payload_json ?? "{}") as Record<string, unknown>;
    expect(payload.decision).toBe("comment");
    expect(payload.review_id).toBe(record.id);
    expect(JSON.stringify(payload)).not.toContain("<script>");
    expect(JSON.stringify(payload)).not.toContain(hostile.slice(0, 16));
  });

  it("treats reviews as immutable history", async () => {
    const f = await fixture();
    const version = await f.available("v03-immutable");
    const record = result(
      await f.review({
        artifactId: version.artifact_id,
        versionId: version.version_id,
        expectedContentHash: version.content_hash,
        expectedLatestVersionId: version.version_id,
        decision: "approve",
      }),
    );
    await expect(
      f.db
        .prepare(`UPDATE artifact_reviews SET decision = 'comment' WHERE workspace_id = ? AND id = ?`)
        .run(FIX.workspace, record.id),
    ).rejects.toThrow();
    await expect(
      f.db.prepare(`DELETE FROM artifact_reviews WHERE workspace_id = ? AND id = ?`).run(
        FIX.workspace,
        record.id,
      ),
    ).rejects.toThrow();
  });

  it("validates decision, comment, git, config, and observation shapes", async () => {
    const f = await fixture();
    const version = await f.available("v03-shapes");
    const base = {
      artifactId: version.artifact_id,
      versionId: version.version_id,
      expectedContentHash: version.content_hash,
      expectedLatestVersionId: version.version_id,
    };
    expect(await failure(f.review({ ...base, decision: "merge" }))).toBe("invalid_argument");
    expect(await failure(f.review({ ...base, decision: "approve", comment: "" }))).toBe(
      "invalid_argument",
    );
    expect(
      await failure(f.review({ ...base, decision: "approve", comment: "x".repeat(2049) })),
    ).toBe("invalid_argument");
    expect(await failure(f.review({ ...base, decision: "approve", gitCommit: "abc" }))).toBe(
      "invalid_argument",
    );
    expect(
      await failure(f.review({ ...base, decision: "approve", configHash: "nope" })),
    ).toBe("invalid_argument");
    expect(
      await failure(
        f.review({ ...base, decision: "approve", reviewTimerObservationId: "nope" }),
      ),
    ).toBe("invalid_argument");
    expect(
      await failure(f.review({ ...base, decision: "approve", expectedContentHash: "zz" })),
    ).toBe("invalid_argument");
    expect(
      await failure(f.review({ ...base, decision: "approve", unexpected: true })),
    ).toBe("invalid_argument");
  });
});

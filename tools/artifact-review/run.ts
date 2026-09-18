// ABOUTME: Proves V03 reviews serialize across real independent Workers and D1.
// ABOUTME: Exact binding, stale-version races, authority limits, and A04 reads run on D1.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { adaptD1, loadMigrationManifest, type D1Like, type SqlDatabase } from "@bfb/db";
import {
  artifactEvidenceVersionMap,
  getArtifactReviewStatus,
  getTaskMeasurements,
  listArtifactReviews,
  listResultSubmissions,
  listReviewTimerObservations,
  listReviewTimers,
  mintUploadGrantSecret,
  randomUlid,
  recordVerifiedUpload,
  redeemUploadGrant,
  type CommandOutcome,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migrationManifest = loadMigrationManifest(resolve(repoRoot, "migrations/d1"));
const origin = "https://bfb.v03.test";
const now = "2026-09-18T08:00:00.000Z";
const later = "2026-09-18T09:00:00.000Z";
const commitA = "a".repeat(40);
const commitB = "b".repeat(40);
const server = createTestHarness({
  root: repoRoot,
  workers: [
    { configPath: "tools/artifact-review/wrangler-a.toml" },
    { configPath: "tools/artifact-review/wrangler-b.toml" },
    { configPath: "tools/artifact-review/wrangler-hub.toml" },
  ],
});

interface HubEnv {
  DB: D1Like;
}

type WorkerName = "bfb-v03-a" | "bfb-v03-b";

function humanCommand(
  workspaceId: string,
  humanId: string,
  commandName: string,
  idempotencyKey: string,
  input: unknown,
  at: string = now,
) {
  return {
    commandName,
    request: {
      workspaceId,
      idempotencyKey,
      actorHumanId: humanId,
      authorizationEpoch: 1,
      now: at,
      input,
    },
  };
}

function runnerCommand(
  workspaceId: string,
  runnerId: string,
  commandName: string,
  idempotencyKey: string,
  input: unknown,
) {
  return {
    commandName,
    request: {
      workspaceId,
      idempotencyKey,
      actorRunnerId: runnerId,
      authorizationEpoch: 1,
      now,
      input,
    },
  };
}

async function execute<TResult>(
  workerName: WorkerName,
  workspaceId: string,
  value: unknown,
): Promise<CommandOutcome<TResult>> {
  const response = await server
    .getWorker(workerName)
    .fetch(`${origin}/workspaces/${workspaceId}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as CommandOutcome<TResult>;
}

function ok<TResult>(outcome: CommandOutcome<TResult>, label: string): TResult {
  if (!outcome.ok) {
    throw new Error(`${label}: ${JSON.stringify(outcome)}`);
  }
  return outcome.result;
}

function failureCode(outcome: CommandOutcome<never>, label: string): string {
  if (outcome.ok) {
    throw new Error(`${label}: expected failure`);
  }
  return outcome.error.code;
}

function digest(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

async function seedHuman(
  db: SqlDatabase,
  workspaceId: string,
  humanId: string,
  email: string,
  name: string,
  role: "owner" | "member" | "reviewer",
): Promise<void> {
  await db
    .prepare(`INSERT INTO humans (id, email, display_name, created_at) VALUES (?, ?, ?, ?)`)
    .run(humanId, email, name, now);
  await db
    .prepare(
      `INSERT INTO workspace_members
       (workspace_id, human_id, role, authorization_epoch, created_at)
       VALUES (?, ?, ?, 1, ?)`,
    )
    .run(workspaceId, humanId, role, now);
  await db
    .prepare(
      `INSERT INTO workspace_authorization_epochs
       (workspace_id, human_id, authorization_epoch, revoked_at, updated_at)
       VALUES (?, ?, 1, NULL, ?)`,
    )
    .run(workspaceId, humanId, now);
}

async function publish(
  worker: WorkerName,
  db: SqlDatabase,
  input: {
    workspaceId: string;
    owner: string;
    artifactId: string | null;
    runId: string | null;
    label: string;
    key: string;
    at?: string;
  },
): Promise<{ artifact_id: string; version_id: string; content_hash: string }> {
  const at = input.at ?? now;
  const contentHash = digest(input.label);
  const bytes = new TextEncoder().encode(`synthetic ${input.label}\n`);
  const minted = mintUploadGrantSecret();
  const created = ok<{ artifact_id: string; version_id: string }>(
    await execute(
      worker,
      input.workspaceId,
      humanCommand(
        input.workspaceId,
        input.owner,
        "artifact.create_version",
        input.key,
        {
          artifactId: input.artifactId,
          runId: input.runId,
          format: "markdown",
          role: "review",
          declaredSize: bytes.byteLength,
          expectedDigest: contentHash,
          grantSecretHash: minted.secretHash,
        },
        at,
      ),
    ),
    "artifact.create_version",
  );
  await redeemUploadGrant(db, {
    grantId: (created as unknown as { upload_grant: { grant_id: string } }).upload_grant.grant_id,
    secret: minted.secret,
    now: at,
  });
  await recordVerifiedUpload(db, {
    workspaceId: input.workspaceId,
    versionId: created.version_id,
    runId: input.runId,
    role: "review",
    contentHash,
    r2Key: `workspaces/${input.workspaceId}/artifacts/sha256/${contentHash}`,
    size: bytes.byteLength,
    now: at,
  });
  ok(
    await execute(
      worker === "bfb-v03-a" ? "bfb-v03-b" : "bfb-v03-a",
      input.workspaceId,
      humanCommand(
        input.workspaceId,
        input.owner,
        "artifact.finalize_version",
        `${input.key}-finalize`,
        { versionId: created.version_id, contentHash, size: bytes.byteLength },
        at,
      ),
    ),
    "artifact.finalize_version",
  );
  return {
    artifact_id: created.artifact_id,
    version_id: created.version_id,
    content_hash: contentHash,
  };
}

async function main(): Promise<void> {
  const snapshots: Record<string, unknown> = {};
  const checks: string[] = [];
  try {
    await server.listen();
    const hubWorker = server.getWorker("bfb-v03-hub");
    await hubWorker.applyD1Migrations("DB");
    // The harness asserts its own migration is registered and applied; it
    // never asserts it is the newest head, so sibling packages stay free.
    assert.ok(
      migrationManifest.migrations.some((entry) => entry.id === "0032_artifact_review"),
      "V03 artifact review migration must be registered",
    );
    const env = (await hubWorker.getEnv()) as unknown as HubEnv;
    const db = adaptD1(env.DB);
    const applied = (await db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifact_reviews'`)
      .get()) as { name?: string } | undefined;
    assert.equal(applied?.name, "artifact_reviews", "V03 review table must be applied");
    checks.push("0032_artifact_review is registered and applied without claiming newest head");

    const workspaceId = randomUlid();
    const owner = randomUlid();
    const reviewer = randomUlid();
    await db
      .prepare(
        `INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version)
         VALUES (?, 'v03-workerd', 'global', ?, 1)`,
      )
      .run(workspaceId, now);
    await seedHuman(db, workspaceId, owner, "v03-owner@synthetic.test", "V03 Owner", "owner");
    await seedHuman(
      db,
      workspaceId,
      reviewer,
      "v03-reviewer@synthetic.test",
      "V03 Reviewer",
      "reviewer",
    );

    const project = ok<{ id: string }>(
      await execute(
        "bfb-v03-a",
        workspaceId,
        humanCommand(workspaceId, owner, "project.create", "v03-project", {
          name: "V03 Workerd",
          slug: "v03-workerd",
          tint: "#336699",
          accessMode: "workspace",
          repositoryHost: "github.com",
          hostedRepositoryId: "v03-workerd-repository",
          repositorySubpath: ".",
        }),
      ),
      "project.create",
    );
    const profile = ok<{ id: string }>(
      await execute(
        "bfb-v03-a",
        workspaceId,
        humanCommand(workspaceId, owner, "agent_profile.create", "v03-profile", {
          name: "V03 Codex",
          provider: "codex",
          executionMode: "interactive",
          harnessMode: "restricted",
        }),
      ),
      "agent_profile.create",
    );
    const task = ok<{ id: string }>(
      await execute(
        "bfb-v03-a",
        workspaceId,
        humanCommand(workspaceId, owner, "task.create", "v03-task", {
          projectId: project.id,
          title: "Race the review domain",
          priority: "P1",
          nextOwnerType: "agent_profile",
          nextOwnerId: profile.id,
        }),
      ),
      "task.create",
    );
    const run = ok<{ run: { id: string } }>(
      await execute(
        "bfb-v03-a",
        workspaceId,
        humanCommand(workspaceId, owner, "run.create", "v03-run-create", {
          taskId: task.id,
          expectedTaskVersion: 1,
          agentProfileId: profile.id,
          workspacePolicyVersion: 1,
          projectPolicyVersion: 1,
          repositoryConfigVersion: 1,
          agentProfileVersion: 1,
        }),
      ),
      "run.create",
    );
    checks.push("task and run seed through independent isolates");

    const first = await publish("bfb-v03-a", db, {
      workspaceId,
      owner,
      artifactId: null,
      runId: run.run.id,
      label: "v03-workerd-v1",
      key: "v03-publish-v1",
    });
    const versionBefore = (await db
      .prepare(`SELECT * FROM artifact_versions WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, first.version_id)) as Record<string, unknown>;
    const runBefore = (await db
      .prepare(`SELECT result_state, resource_version FROM runs WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, run.run.id)) as Record<string, unknown>;
    const taskBefore = (await db
      .prepare(`SELECT state, resource_version FROM tasks WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, task.id)) as Record<string, unknown>;

    const review = ok<{ id: string }>(
      await execute(
        "bfb-v03-a",
        workspaceId,
        humanCommand(workspaceId, owner, "artifact.record_review", "v03-review-v1", {
          artifactId: first.artifact_id,
          versionId: first.version_id,
          expectedContentHash: first.content_hash,
          expectedLatestVersionId: first.version_id,
          decision: "approve",
          comment: "Synthetic workerd approval",
        }),
      ),
      "artifact.record_review",
    );
    const versionAfter = (await db
      .prepare(`SELECT * FROM artifact_versions WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, first.version_id)) as Record<string, unknown>;
    assert.deepEqual(versionAfter, versionBefore);
    checks.push("approve binds the exact version and hash without mutating the version");

    assert.equal(
      failureCode(
        await execute(
          "bfb-v03-b",
          workspaceId,
          humanCommand(workspaceId, reviewer, "artifact.record_review", "v03-review-bad-hash", {
            artifactId: first.artifact_id,
            versionId: first.version_id,
            expectedContentHash: digest("v03-other-bytes"),
            expectedLatestVersionId: first.version_id,
            decision: "approve",
          }),
        ),
        "hash mismatch",
      ),
      "version_mismatch",
    );
    assert.equal(
      failureCode(
        await execute(
          "bfb-v03-a",
          workspaceId,
          runnerCommand(workspaceId, randomUlid(), "artifact.record_review", "v03-review-runner", {
            artifactId: first.artifact_id,
            versionId: first.version_id,
            expectedContentHash: first.content_hash,
            expectedLatestVersionId: first.version_id,
            decision: "approve",
          }),
        ),
        "runner review",
      ),
      "forbidden",
    );
    checks.push("hash mismatch and runner authority fail across isolates");

    // A newer publication on the other isolate makes the first review stale.
    const second = await publish("bfb-v03-b", db, {
      workspaceId,
      owner,
      artifactId: first.artifact_id,
      runId: run.run.id,
      label: "v03-workerd-v2",
      key: "v03-publish-v2",
      at: later,
    });
    assert.equal(
      failureCode(
        await execute(
          "bfb-v03-a",
          workspaceId,
          humanCommand(workspaceId, reviewer, "artifact.record_review", "v03-review-stale", {
            artifactId: first.artifact_id,
            versionId: first.version_id,
            expectedContentHash: first.content_hash,
            expectedLatestVersionId: first.version_id,
            decision: "approve",
          }),
        ),
        "stale review",
      ),
      "stale_version",
    );
    checks.push("concurrent publication resolves through explicit version conflict");

    ok(
      await execute(
        "bfb-v03-b",
        workspaceId,
        humanCommand(workspaceId, reviewer, "artifact.record_review", "v03-review-v2", {
          artifactId: first.artifact_id,
          versionId: second.version_id,
          expectedContentHash: second.content_hash,
          expectedLatestVersionId: second.version_id,
          decision: "request_changes",
          comment: "Synthetic workerd change request",
        }),
      ),
      "reviewer request_changes on latest",
    );
    const status = await getArtifactReviewStatus(db, workspaceId, first.artifact_id);
    assert.equal(status?.approved, false);
    assert.equal(status?.changes_requested, true);
    assert.equal(status?.review_count, 2);
    assert.equal(status?.historical_count, 1);
    assert.equal(status?.latest_version?.id, second.version_id);
    const reviews = await listArtifactReviews(db, workspaceId, first.artifact_id);
    assert.equal(reviews[0]?.historical, true);
    assert.deepEqual(reviews[0]?.outdated_reasons, ["newer_version"]);
    snapshots.status_after_republish = {
      approved: status?.approved,
      changes_requested: status?.changes_requested,
      review_count: status?.review_count,
      historical_count: status?.historical_count,
      first_review_reasons: reviews[0]?.outdated_reasons,
    };
    checks.push("new version reads unapproved while history stays intact");

    // Approval changes no run, task, or result state.
    const runAfter = (await db
      .prepare(`SELECT result_state, resource_version FROM runs WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, run.run.id)) as Record<string, unknown>;
    const taskAfter = (await db
      .prepare(`SELECT state, resource_version FROM tasks WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, task.id)) as Record<string, unknown>;
    assert.deepEqual(runAfter, runBefore);
    assert.deepEqual(taskAfter, taskBefore);
    const submissions = await listResultSubmissions(db, workspaceId, run.run.id);
    assert.deepEqual(submissions, []);
    checks.push("reviews never move run, task, or result state");

    // Link a submission bound to the first version, then prove the A03
    // evidence map marks it outdated once the second version exists.
    ok(
      await execute(
        "bfb-v03-a",
        workspaceId,
        humanCommand(workspaceId, owner, "result.submit", "v03-submit", {
          runId: run.run.id,
          summary: "Synthetic workerd submission",
          evidenceRefs: [
            {
              kind: "artifact_version",
              ref: first.artifact_id,
              version: first.version_id,
              hash: `sha256:${first.content_hash}`,
            },
          ],
          gitBranch: "main",
          gitCommit: commitA,
          gitDirty: false,
        }),
      ),
      "result.submit",
    );
    const evidenceMap = await artifactEvidenceVersionMap(db, workspaceId);
    assert.equal(evidenceMap.get(`artifact_version\n${first.artifact_id}`), second.version_id);
    const outdated = await listResultSubmissions(db, workspaceId, run.run.id, evidenceMap);
    assert.equal(outdated[0]?.outdated, true);
    assert.ok(outdated[0]?.outdated_reasons.includes("evidence_changed"));
    checks.push("artifact-bound submissions read outdated through the V03 evidence map");

    // The human-controlled timer is A04 state: V03 links its observation and
    // reads durations without writing or computing timer state.
    const timer = ok<{ id: string; resource_version: number }>(
      await execute(
        "bfb-v03-a",
        workspaceId,
        humanCommand(workspaceId, owner, "review_timer.start", "v03-timer-start", {
          taskId: task.id,
          runId: run.run.id,
        }),
      ),
      "review_timer.start",
    );
    const observationsBefore = await listReviewTimerObservations(db, workspaceId, timer.id);
    assert.ok(observationsBefore.length >= 1);
    const timersBefore = await listReviewTimers(db, workspaceId, task.id);
    ok(
      await execute(
        "bfb-v03-b",
        workspaceId,
        humanCommand(
          workspaceId,
          owner,
          "review_timer.stop",
          "v03-timer-stop",
          {
            timerId: timer.id,
            expectedVersion: timer.resource_version,
          },
          later,
        ),
      ),
      "review_timer.stop",
    );
    ok(
      await execute(
        "bfb-v03-a",
        workspaceId,
        humanCommand(workspaceId, owner, "artifact.record_review", "v03-review-timer", {
          artifactId: first.artifact_id,
          versionId: second.version_id,
          expectedContentHash: second.content_hash,
          expectedLatestVersionId: second.version_id,
          decision: "comment",
          comment: "Synthetic timed note",
          gitCommit: commitB,
          reviewTimerObservationId: observationsBefore[0]?.observation_id,
        }),
      ),
      "review links timer observation",
    );
    assert.deepEqual(await listReviewTimers(db, workspaceId, task.id), [
      { ...timersBefore[0], state: "stopped", stopped_at: later, resource_version: 2 },
    ]);
    assert.equal(
      (await listReviewTimerObservations(db, workspaceId, timer.id)).length,
      observationsBefore.length + 1,
    );
    const measured = await getTaskMeasurements(db, workspaceId, task.id, later);
    assert.ok(measured.review.stopped_total_ms > 0);
    snapshots.review_timer = {
      stopped_total_ms: measured.review.stopped_total_ms,
      observation_kinds: (await listReviewTimerObservations(db, workspaceId, timer.id)).map(
        (entry) => entry.observed_kind,
      ),
    };
    checks.push("review duration reads from A04 observations; V03 computes nothing");

    // Browser presence never enters review state.
    ok(
      await execute(
        "bfb-v03-a",
        workspaceId,
        humanCommand(workspaceId, owner, "browser_activity.record", "v03-presence", {
          taskId: task.id,
          startedAt: now,
          endedAt: later,
        }),
      ),
      "browser_activity.record",
    );
    const presenceStatus = await getArtifactReviewStatus(db, workspaceId, first.artifact_id);
    assert.ok(!("presence" in (presenceStatus ?? {})));
    assert.ok(!("browser_activity" in (presenceStatus ?? {})));
    assert.equal(presenceStatus?.review_count, 3);
    checks.push("presence observations stay out of review records and reads");

    // Audit carries identities and the decision only.
    const audits = (await db
      .prepare(
        `SELECT action, payload_json FROM artifact_audit_outbox
         WHERE workspace_id = ? AND version_id = ? AND action = 'artifact.review_recorded'
         ORDER BY created_at ASC`,
      )
      .all(workspaceId, first.version_id)) as Array<{ action: string; payload_json: string }>;
    assert.ok(audits.length >= 1);
    const payload = JSON.parse(audits[0]?.payload_json ?? "{}") as Record<string, unknown>;
    assert.equal(payload.decision, "approve");
    assert.equal(payload.review_id, review.id);
    assert.ok(!JSON.stringify(payload).includes("Synthetic workerd approval"));
    snapshots.audit_payload_keys = Object.keys(payload).sort();
    checks.push("audit facts carry identities without comment text or secrets");

    snapshots.review_count = presenceStatus?.review_count;
    const evidenceDir = resolve(repoRoot, "docs/work-packages/evidence/WP-V03");
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(
      resolve(evidenceDir, "review-binding.json"),
      `${JSON.stringify({ snapshots, checks }, null, 2)}\n`,
    );
    console.log(`V03_D1_OK (${checks.length} checks)`);
    for (const check of checks) {
      console.log(`- ${check}`);
    }
  } catch (error) {
    server.debug();
    throw error;
  } finally {
    await server.close();
  }
}

await main();

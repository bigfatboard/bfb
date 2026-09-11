// ABOUTME: Certifies runner possession and enrollment races across two real Worker isolates.
// ABOUTME: Production D1 batches, durable abuse limits, and sanitized revocation signals are asserted.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { adaptD1, type D1Like } from "@bfb/db";
import {
  FIX,
  canonicalRunnerKey,
  issueStepUpProof,
  randomUlid,
  runnerChallengeTranscript,
  runnerEnrollmentTarget,
  runnerHash,
  runnerGrantsTarget,
  seedSyntheticWorkspace,
  type RunnerChallenge,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ORIGIN = "https://bfb.runners.test";
const NOW = "2026-09-11T20:00:00.000Z";
const SIGNING_KEY = "c06-runtime-current-signing-key-84d1e9";
const sessionId = "c06-synthetic-session";
const sessionToken = "c06-synthetic-session-token";
const cookie = `__Host-bfb_session=${encodeURIComponent(`${sessionToken}.${createHmac("sha256", SIGNING_KEY).update(sessionToken).digest("base64")}`)}`;
const csrf = `2.${createHmac("sha256", SIGNING_KEY).update(`bfb-csrf:${sessionId}`).digest("hex")}`;
const server = createTestHarness({
  root: repoRoot,
  workers: [
    { configPath: "tools/runners/wrangler-a.toml" },
    { configPath: "tools/runners/wrangler-b.toml" },
    { configPath: "tools/runners/wrangler-hub.toml" },
  ],
});

function post(index: number, path: string, body: unknown, browser = false, ip = "192.0.2.106") {
  return server
    .getWorker(index % 2 === 0 ? "bfb-runners-a" : "bfb-runners-b")
    .fetch(ORIGIN + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": ip,
        ...(browser
          ? { cookie, origin: ORIGIN, "sec-fetch-site": "same-origin", "x-bfb-csrf": csrf }
          : {}),
      },
      body: JSON.stringify(body),
    });
}

async function accepted<T>(response: Awaited<ReturnType<typeof post>>, status = 200): Promise<T> {
  assert.equal(response.status, status, `unexpected status ${response.status}`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return (await response.json()) as T;
}

async function main() {
  try {
    await server.listen();
    const worker = server.getWorker("bfb-runners-a");
    await worker.applyD1Migrations("DB");
    const env = (await worker.getEnv()) as unknown as { DB: D1Like };
    const db = adaptD1(env.DB);
    // Workerd does not implement jurisdiction selection. Hub-client unit tests
    // cover persisted EU/US routing; this fixture exercises the global namespace.
    await seedSyntheticWorkspace(db, NOW, "global");
    await db
      .prepare(
        `INSERT INTO better_auth_users (id, name, email, email_verified, created_at, updated_at) VALUES ('c06-user', 'Synthetic Runner Owner', 'owner@synthetic.test', 1, ?, ?)`,
      )
      .run(NOW, NOW);
    await db
      .prepare(`UPDATE humans SET better_auth_user_id = 'c06-user' WHERE id = ?`)
      .run(FIX.owner);
    await db
      .prepare(
        `INSERT INTO better_auth_sessions (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, '2027-09-11T20:00:00.000Z', ?, ?, ?, 'c06-user')`,
      )
      .run(sessionId, sessionToken, NOW, NOW);

    async function step(action: string, target: string, workspaceId = FIX.workspace) {
      return issueStepUpProof(
        db,
        FIX.owner,
        {
          action,
          targetId: target,
          workspaceId,
          scopes: [],
          authorizationEpoch: 1,
          expiresAt: "2026-09-11T20:05:00.000Z",
        },
        NOW,
      );
    }
    async function enrollment(workspaceId = FIX.workspace, projects = [FIX.projectA]) {
      const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ]);
      const jwk = await crypto.subtle.exportKey("jwk", key.publicKey);
      const input = {
        runnerId: randomUlid(),
        deviceLabel: "Workerd Synthetic Mac",
        publicKey: await canonicalRunnerKey({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }),
        projectIds: projects,
      };
      const proof = await step("runner.enroll", runnerEnrollmentTarget(input), workspaceId);
      const browserPath = `/api/v1/workspaces/${workspaceId}/runners`;
      const nativePath = `/runner/workspaces/${workspaceId}/runners/${input.runnerId}`;
      const body = {
        runner_id: input.runnerId,
        device_label: input.deviceLabel,
        public_key: input.publicKey,
        project_ids: input.projectIds,
        step_up_proof_id: proof,
      };
      async function challenge(
        index: number,
        extra: Record<string, unknown> = {},
        ip = "192.0.2.106",
      ) {
        return (
          await accepted<{ challenge: RunnerChallenge }>(
            await post(index, nativePath + "/challenge", { purpose: "token", ...extra }, false, ip),
          )
        ).challenge;
      }
      async function signed(challenge: RunnerChallenge) {
        const bytes = await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          key.privateKey,
          runnerChallengeTranscript(challenge),
        );
        return {
          challenge_id: challenge.challenge_id,
          server_nonce: challenge.server_nonce,
          signature: Buffer.from(bytes).toString("base64url"),
        };
      }
      return { input, body, browserPath, nativePath, challenge, signed };
    }

    const first = await enrollment();
    const enrollmentRace = await Promise.all(
      [0, 1].map((index) => post(index, first.browserPath, first.body, true)),
    );
    assert.deepEqual(enrollmentRace.map((response) => response.status).sort(), [201, 403]);
    const challenges = await Promise.all([first.challenge(0), first.challenge(1)]);
    const proofs = await Promise.all(challenges.map((challenge) => first.signed(challenge)));
    const tokenRace = await Promise.all(
      proofs.map((proof, index) => post(index, first.nativePath + "/token", proof)),
    );
    assert.deepEqual(tokenRace.map((response) => response.status).sort(), [200, 403]);
    const winner = tokenRace.find((response) => response.status === 200)!;
    const issued = await accepted<{ token: string }>(winner);
    assert.match(issued.token, /^bfb_runner_/);
    const binding = {
      method: "POST",
      path: first.nativePath + "/authenticate",
      body_sha256: runnerHash(""),
    };
    const authChallenge = await first.challenge(0, {
      purpose: "request",
      token: issued.token,
      request: binding,
    });
    const authProof = await first.signed(authChallenge);
    const requestRace = await Promise.all(
      [0, 1].map((index) =>
        post(index, first.nativePath + "/authenticate", { ...authProof, token: issued.token }),
      ),
    );
    assert.deepEqual(requestRace.map((response) => response.status).sort(), [200, 403]);

    const workspaceB = randomUlid();
    await db
      .prepare(
        `INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version) VALUES (?, 'c06-workspace-b', 'global', ?, 1)`,
      )
      .run(workspaceB, NOW);
    await db
      .prepare(
        `INSERT INTO workspace_members (workspace_id, human_id, role, authorization_epoch, created_at) VALUES (?, ?, 'owner', 1, ?)`,
      )
      .run(workspaceB, FIX.owner, NOW);
    await db
      .prepare(
        `INSERT INTO workspace_authorization_epochs (workspace_id, human_id, authorization_epoch, updated_at) VALUES (?, ?, 1, ?)`,
      )
      .run(workspaceB, FIX.owner, NOW);
    const second = await enrollment(workspaceB, []);
    const collidingKey = { ...second.input, publicKey: first.input.publicKey };
    const collisionProof = await step(
      "runner.enroll",
      runnerEnrollmentTarget(collidingKey),
      workspaceB,
    );
    assert.equal(
      (
        await post(
          0,
          second.browserPath,
          { ...second.body, public_key: collidingKey.publicKey, step_up_proof_id: collisionProof },
          true,
        )
      ).status,
      403,
    );
    // A unique-key failure occurs after the queued proof update. D1 must roll
    // back that update and the entire command, not partially consume approval.
    assert.deepEqual(
      await db
        .prepare(`SELECT consumed_at FROM passkey_step_up_proofs WHERE proof_id = ?`)
        .get(collisionProof),
      { consumed_at: null },
    );
    await accepted(await post(1, second.browserPath, second.body, true), 201);
    const secondChallenge = await second.challenge(1);
    const secondProof = await second.signed(secondChallenge);
    const secondToken = await accepted<{ token: string }>(
      await post(0, second.nativePath + "/token", secondProof),
    );
    assert.notEqual(secondToken.token, issued.token);
    assert.notEqual(secondChallenge.public_key_thumbprint, challenges[0]!.public_key_thumbprint);
    assert.equal((await post(0, second.nativePath + "/token", proofs[0])).status, 403);
    assert.equal(
      (
        await post(1, second.nativePath + "/challenge", {
          purpose: "request",
          token: issued.token,
          request: { ...binding, path: second.nativePath + "/authenticate" },
        })
      ).status,
      403,
    );

    const grants = {
      runnerId: first.input.runnerId,
      expectedGrantEpoch: 1,
      projectIds: [FIX.projectA],
      launcherHumanIds: [FIX.owner, FIX.member],
    };
    const grantProof = await step("runner.grants.replace", runnerGrantsTarget(grants));
    const grantRace = await Promise.all(
      [0, 1].map((index) =>
        post(
          index,
          first.browserPath + `/${grants.runnerId}/grants`,
          {
            expected_grant_epoch: 1,
            project_ids: grants.projectIds,
            launcher_human_ids: grants.launcherHumanIds,
            step_up_proof_id: grantProof,
          },
          true,
        ),
      ),
    );
    assert.deepEqual(grantRace.map((response) => response.status).sort(), [200, 403]);
    assert.equal(
      (
        await post(0, first.nativePath + "/challenge", {
          purpose: "request",
          token: issued.token,
          request: binding,
        })
      ).status,
      403,
    );
    const pending = await first.signed(await first.challenge(1));
    const revokeProof = await step("runner.revoke", first.input.runnerId);
    const revoke = await accepted<{ signal: { reason: string } }>(
      await post(
        0,
        first.browserPath + `/${first.input.runnerId}/revoke`,
        { step_up_proof_id: revokeProof },
        true,
      ),
    );
    assert.equal(revoke.signal.reason, "revoked");
    assert.equal((await post(1, first.nativePath + "/token", pending)).status, 403);
    const retained = (await db
      .prepare(
        `SELECT COUNT(*) AS count FROM runner_tokens WHERE workspace_id = ? AND runner_id = ? AND revoked_at IS NULL`,
      )
      .get(FIX.workspace, first.input.runnerId)) as { count: number };
    assert.equal(retained.count, 1);
    const signals = (await db
      .prepare(
        `SELECT COUNT(*) AS count FROM runner_channel_signals WHERE workspace_id = ? AND runner_id = ? AND reason = 'revoked'`,
      )
      .get(FIX.workspace, first.input.runnerId)) as { count: number };
    assert.equal(signals.count, 1);
    assert.deepEqual(
      await db
        .prepare(
          `SELECT authorization_epoch, grant_epoch, token_epoch, revoked_at FROM runners WHERE workspace_id = ? AND id = ?`,
        )
        .get(workspaceB, second.input.runnerId),
      {
        authorization_epoch: 1,
        grant_epoch: 1,
        token_epoch: 1,
        revoked_at: null,
      },
    );
    const secondBinding = { ...binding, path: second.nativePath + "/authenticate" };
    const secondAuth = await second.signed(
      await second.challenge(1, {
        purpose: "request",
        token: secondToken.token,
        request: secondBinding,
      }),
    );
    await accepted(
      await post(0, second.nativePath + "/authenticate", {
        ...secondAuth,
        token: secondToken.token,
      }),
    );

    const limited = await enrollment();
    await accepted(await post(1, limited.browserPath, limited.body, true), 201);
    let limitedChallenge: RunnerChallenge | undefined;
    for (let index = 0; index < 20; index += 1) {
      const challenge = await limited.challenge(index, {}, "192.0.2.206");
      limitedChallenge ??= challenge;
    }
    for (const ip of ["192.0.2.206", "192.0.2.207"]) {
      const rejection = await post(
        1,
        limited.nativePath + "/challenge",
        { purpose: "token" },
        false,
        ip,
      );
      assert.equal(rejection.status, 403);
      assert.deepEqual(await rejection.json(), {
        error: "request_rejected",
        message: "request rejected",
      });
    }
    // Invalid proof exchanges and failed browser approvals consume their own durable limits.
    for (let index = 0; index < 22; index += 1) {
      assert.equal(
        (await post(index, limited.nativePath + "/token", {}, false, "192.0.2.208")).status,
        403,
      );
      assert.equal((await post(index, limited.browserPath, {}, true, "192.0.2.209")).status, 403);
    }
    assert(limitedChallenge);
    const validButLimited = await limited.signed(limitedChallenge);
    assert.equal(
      (await post(0, limited.nativePath + "/token", validButLimited, false, "192.0.2.210")).status,
      403,
    );
    assert.deepEqual(
      await db
        .prepare(`SELECT consumed_at FROM runner_challenges WHERE workspace_id = ? AND id = ?`)
        .get(FIX.workspace, limitedChallenge.challenge_id),
      { consumed_at: null },
    );
    const blockedApproval = await enrollment();
    assert.equal(
      (await post(1, blockedApproval.browserPath, blockedApproval.body, true, "192.0.2.211"))
        .status,
      403,
    );
    assert.deepEqual(
      await db
        .prepare(`SELECT consumed_at FROM passkey_step_up_proofs WHERE proof_id = ?`)
        .get(blockedApproval.body.step_up_proof_id),
      { consumed_at: null },
    );
    const buckets = (await db
      .prepare(`SELECT bucket_key, count FROM rate_limit_buckets`)
      .all()) as { bucket_key: string; count: number }[];
    assert(buckets.some((bucket) => bucket.count > 20));
    for (const bucket of buckets) assert.match(bucket.bucket_key, /^[0-9a-f]{64}$/);

    for (const table of [
      "runners",
      "runner_challenges",
      "runner_tokens",
      "runner_channel_signals",
      "semantic_events",
      "audit_events",
      "outbox_records",
      "idempotency_records",
      "rate_limit_buckets",
    ]) {
      const dump = JSON.stringify(await db.prepare(`SELECT * FROM ${table}`).all());
      for (const secret of [
        issued.token,
        secondToken.token,
        ...proofs.flatMap((proof) => [proof.server_nonce, proof.signature]),
        authProof.server_nonce,
        authProof.signature,
        "192.0.2.",
        "/Users/",
      ])
        assert(!dump.includes(secret), `secret retained in ${table}`);
    }
    assert.deepEqual(
      await db.prepare(`SELECT COUNT(*) AS count FROM runner_mutation_guards`).get(),
      { count: 0 },
    );
    console.log(
      JSON.stringify({
        workers: 3,
        enrollments: 3,
        workspaces: 2,
        enrollmentRace: enrollmentRace.map((item) => item.status).sort(),
        tokenRace: tokenRace.map((item) => item.status).sort(),
        requestRace: requestRace.map((item) => item.status).sort(),
        grantRace: grantRace.map((item) => item.status).sort(),
        crossWorkspace: "rejected",
        abuseCounters: "shared-and-hashed",
        revocationBeforeCleanup: true,
        persistedRawCredentials: false,
      }),
    );
    console.log("C06_D1_OK");
  } finally {
    await server.close();
  }
}

await main();

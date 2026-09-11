// ABOUTME: Exercises runner enrollment, key isolation, request-bound possession, sharing, and revocation.
// ABOUTME: Synthetic keys and database scans prove replay denial and secret-free command persistence.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { SqlDatabase } from "@bfb/db";

import { FIX } from "../src/fixtures.js";
import { WorkspaceHub, type HubCommand, type CommandOutcome } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { loadPrincipal } from "../src/authorization.js";
import { removeMemberCommand } from "../src/workspace-authorization.js";
import { issueStepUpProof, type StepUpAction } from "../src/step-up.js";
import {
  canonicalRunnerKey,
  decodeRunnerToken,
  encodeRunnerToken,
  runnerChallengeTranscript,
  runnerHash,
  runnerSecret,
  type RunnerChallenge,
  type RunnerPublicKey,
  type RunnerTokenClaims,
} from "../src/runner-crypto.js";
import {
  authenticateRunnerRequestCommand,
  assertRunnerLaunchAuthority,
  enrollRunnerCommand,
  exchangeRunnerTokenCommand,
  issueRunnerChallengeCommand,
  listRunners,
  replaceRunnerGrantsCommand,
  revokeRunnerCommand,
  runnerEnrollmentTarget,
  runnerGrantsTarget,
  type EnrollRunnerInput,
  RUNNER_CHALLENGE_ISSUER_ID,
} from "../src/runners.js";
import { openDomainDb } from "./helpers.js";

const NOW = "2026-09-11T20:00:00.000Z";
const ORIGIN = "https://bfb.example.test";

function result<T>(outcome: CommandOutcome<T>): T {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  if (!outcome.ok) throw new Error(outcome.error.code);
  return outcome.result;
}

async function fixture() {
  const db = await openDomainDb();
  const hub = new WorkspaceHub(db);
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const exported = await crypto.subtle.exportKey("jwk", key.publicKey);
  const publicKey = await canonicalRunnerKey({
    crv: exported.crv,
    kty: exported.kty,
    x: exported.x,
    y: exported.y,
  });
  const runner = randomUlid();
  function human<T, R>(
    command: HubCommand<T, R>,
    input: T,
    humanId = FIX.owner,
    now = NOW,
    workspace = FIX.workspace,
    key = randomUlid(),
  ) {
    return hub.execute(command, {
      workspaceId: workspace,
      actorHumanId: humanId,
      authorizationEpoch: 1,
      idempotencyKey: key,
      input,
      now,
    });
  }
  function native<T, R>(command: HubCommand<T, R>, input: T, now = NOW, workspace = FIX.workspace) {
    return hub.execute(command, {
      workspaceId: workspace,
      ...(command.name === issueRunnerChallengeCommand.name
        ? { actorSystemId: RUNNER_CHALLENGE_ISSUER_ID }
        : { actorRunnerId: runner }),
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input,
      now,
    });
  }
  async function step(
    action: string,
    target: string,
    override: Partial<StepUpAction> = {},
    humanId = FIX.owner,
  ) {
    return issueStepUpProof(
      db,
      humanId,
      {
        action,
        targetId: target,
        workspaceId: FIX.workspace,
        scopes: [],
        authorizationEpoch: 1,
        expiresAt: "2026-09-11T20:05:00.000Z",
        ...override,
      },
      NOW,
    );
  }
  const enrollment = {
    runnerId: runner,
    deviceLabel: "Synthetic Mac",
    publicKey,
    projectIds: [FIX.projectA],
  };
  async function enroll() {
    const proof = await step("runner.enroll", runnerEnrollmentTarget(enrollment));
    return result(await human(enrollRunnerCommand, { ...enrollment, stepUpProofId: proof }));
  }
  async function challenge(
    input: Partial<Parameters<typeof issueRunnerChallengeCommand.run>[0]> = {},
    now = NOW,
  ): Promise<RunnerChallenge> {
    const nonce = runnerSecret();
    return {
      ...result(
        await native(
          issueRunnerChallengeCommand,
          {
            runnerId: runner,
            nonceHash: runnerHash(nonce),
            purpose: "token",
            origin: ORIGIN,
            ...input,
          },
          now,
        ),
      ),
      server_nonce: nonce,
    };
  }
  async function proof(challenge: RunnerChallenge, signingKey = key.privateKey) {
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signingKey,
      runnerChallengeTranscript(challenge),
    );
    return {
      runnerId: runner,
      challengeId: challenge.challenge_id,
      serverNonce: challenge.server_nonce,
      signature: Buffer.from(signature).toString("base64url"),
      origin: ORIGIN,
    };
  }
  async function token() {
    const secret = runnerSecret();
    const signed = await proof(await challenge());
    const issued = result(
      await native(exchangeRunnerTokenCommand, { ...signed, tokenSecretHash: runnerHash(secret) }),
    );
    return { token: encodeRunnerToken(issued.claims, secret), issued, signed, secret };
  }
  return {
    db,
    hub,
    key,
    runner,
    publicKey,
    enrollment,
    human,
    native,
    step,
    enroll,
    challenge,
    proof,
    token,
  };
}

async function secondWorkspace(db: SqlDatabase): Promise<string> {
  const workspace = randomUlid();
  await db
    .prepare(
      `INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version) VALUES (?, 'second-runner-workspace', 'eu', ?, 1)`,
    )
    .run(workspace, NOW);
  await db
    .prepare(
      `INSERT INTO workspace_members (workspace_id, human_id, role, authorization_epoch, created_at) VALUES (?, ?, 'owner', 1, ?)`,
    )
    .run(workspace, FIX.owner, NOW);
  await db
    .prepare(
      `INSERT INTO workspace_authorization_epochs (workspace_id, human_id, authorization_epoch, updated_at) VALUES (?, ?, 1, ?)`,
    )
    .run(workspace, FIX.owner, NOW);
  return workspace;
}

describe("runner enrollment authority", () => {
  it("enrolls only its owner, retains project bounds, and rejects implicit teammate/owner authority", async () => {
    const f = await fixture();
    const enrolled = await f.enroll();
    expect(enrolled.launcher_human_ids).toEqual([FIX.owner]);
    expect(enrolled.granted_project_ids).toEqual([FIX.projectA]);
    const owner = await loadPrincipal(f.db, FIX.workspace, FIX.owner);
    const member = await loadPrincipal(f.db, FIX.workspace, FIX.member);
    await expect(
      assertRunnerLaunchAuthority(f.db, owner, f.runner, FIX.projectA),
    ).resolves.toBeUndefined();
    await expect(
      assertRunnerLaunchAuthority(f.db, member, f.runner, FIX.projectA),
    ).rejects.toThrow();
    await expect(
      assertRunnerLaunchAuthority(f.db, owner, f.runner, FIX.projectB),
    ).rejects.toThrow();
    expect(await listRunners(f.db, member)).toEqual([]);
    const memberRunner = {
      ...f.enrollment,
      runnerId: randomUlid(),
      publicKey: await newPublicKey(),
    };
    const proof = await f.step(
      "runner.enroll",
      runnerEnrollmentTarget(memberRunner),
      {},
      FIX.member,
    );
    result(
      await f.human(enrollRunnerCommand, { ...memberRunner, stepUpProofId: proof }, FIX.member),
    );
    await expect(
      assertRunnerLaunchAuthority(f.db, owner, memberRunner.runnerId, FIX.projectA),
    ).rejects.toThrow();
  });

  it.each([
    "missing",
    "expired",
    "action",
    "target",
    "workspace",
    "epoch",
    "human",
    "scope",
    "client",
    "resource",
    "project",
    "task",
  ])("rejects %s enrollment proof without persisting a runner", async (fault) => {
    const f = await fixture();
    const changes: Record<string, Partial<StepUpAction>> = {
      action: { action: "runner.grants.replace" },
      target: { targetId: "other-key" },
      workspace: { workspaceId: randomUlid() },
      epoch: { authorizationEpoch: 2 },
      scope: { scopes: ["bfb:admin"] },
      client: { clientId: "another-client" },
      resource: { resource: ORIGIN },
      project: { projectId: FIX.projectA },
      task: { taskId: randomUlid() },
    };
    const proof =
      fault === "missing"
        ? randomUlid()
        : await f.step(
            "runner.enroll",
            runnerEnrollmentTarget(f.enrollment),
            changes[fault],
            fault === "human" ? FIX.member : FIX.owner,
          );
    expect(
      (
        await f.human(
          enrollRunnerCommand,
          { ...f.enrollment, stepUpProofId: proof },
          FIX.owner,
          fault === "expired" ? "2026-09-11T20:05:00.000Z" : NOW,
        )
      ).ok,
    ).toBe(false);
    expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM runners`).get()).toEqual({ count: 0 });
    expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM audit_events`).get()).toEqual({
      count: 0,
    });
  });

  it("rejects replay even with the original command idempotency key", async () => {
    const f = await fixture();
    const input = {
      ...f.enrollment,
      stepUpProofId: await f.step("runner.enroll", runnerEnrollmentTarget(f.enrollment)),
    };
    const key = randomUlid();
    result(await f.human(enrollRunnerCommand, input, FIX.owner, NOW, FIX.workspace, key));
    expect((await f.human(enrollRunnerCommand, input, FIX.owner, NOW, FIX.workspace, key)).ok).toBe(
      false,
    );
    expect((await f.human(enrollRunnerCommand, input)).ok).toBe(false);
  });

  it.each([
    "reviewer",
    "unknown-project",
    "duplicate-project",
    "private-key",
    "path",
    "unexpected-field",
  ])("rejects %s enrollment data", async (fault) => {
    const f = await fixture();
    const proof = await f.step("runner.enroll", runnerEnrollmentTarget(f.enrollment));
    const input: EnrollRunnerInput = { ...f.enrollment, stepUpProofId: proof };
    if (fault === "unknown-project") input.projectIds = [randomUlid()];
    if (fault === "duplicate-project") input.projectIds = [FIX.projectA, FIX.projectA];
    if (fault === "private-key") Object.assign(input.publicKey, { d: "private-canary" });
    if (fault === "path") input.deviceLabel = "/Users/synthetic/private";
    if (fault === "unexpected-field")
      Object.assign(input, { providerCredential: "credential-canary" });
    expect(
      (await f.human(enrollRunnerCommand, input, fault === "reviewer" ? FIX.reviewer : FIX.owner))
        .ok,
    ).toBe(false);
    expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM runners`).get()).toEqual({ count: 0 });
  });

  it("isolates two workspace keys and refuses key reuse across enrollments", async () => {
    const f = await fixture();
    await f.enroll();
    const first = await f.token();
    const workspaceB = await secondWorkspace(f.db);
    const input = { ...f.enrollment, runnerId: randomUlid(), projectIds: [] };
    const reusedProof = await f.step("runner.enroll", runnerEnrollmentTarget(input), {
      workspaceId: workspaceB,
    });
    expect(
      (
        await f.human(
          enrollRunnerCommand,
          { ...input, stepUpProofId: reusedProof },
          FIX.owner,
          NOW,
          workspaceB,
        )
      ).ok,
    ).toBe(false);
    input.publicKey = await newPublicKey();
    const proof = await f.step("runner.enroll", runnerEnrollmentTarget(input), {
      workspaceId: workspaceB,
    });
    const second = result(
      await f.human(
        enrollRunnerCommand,
        { ...input, stepUpProofId: proof },
        FIX.owner,
        NOW,
        workspaceB,
      ),
    );
    expect(second.public_key_thumbprint).not.toBe(first.issued.claims.cnf.jkt);
    expect(second.runner_id).not.toBe(f.runner);
    expect(
      (
        await f.native(
          exchangeRunnerTokenCommand,
          { ...first.signed, tokenSecretHash: runnerHash(runnerSecret()) },
          NOW,
          workspaceB,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await f.hub.execute(issueRunnerChallengeCommand, {
          workspaceId: workspaceB,
          actorSystemId: RUNNER_CHALLENGE_ISSUER_ID,
          authorizationEpoch: 1,
          idempotencyKey: randomUlid(),
          now: NOW,
          input: {
            runnerId: input.runnerId,
            purpose: "request",
            origin: ORIGIN,
            nonceHash: runnerHash(runnerSecret()),
            token: first.token,
            request: {
              method: "GET",
              path: `/runner/workspaces/${workspaceB}/runners/${input.runnerId}/channel`,
              body_sha256: runnerHash(""),
            },
          },
        })
      ).ok,
    ).toBe(false);
  });
});

async function newPublicKey(): Promise<RunnerPublicKey> {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const value = await crypto.subtle.exportKey("jwk", key.publicKey);
  return canonicalRunnerKey({ crv: value.crv, kty: value.kty, x: value.x, y: value.y });
}

describe("runner possession and renewal", () => {
  it("round-trips the public token claims fixture without treating claims as authentication", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("../../../protocol/fixtures/runner-token-claims.json", import.meta.url),
        "utf8",
      ),
    ) as { claims: RunnerTokenClaims };
    const secret = runnerSecret();
    const decoded = decodeRunnerToken(encodeRunnerToken(fixture.claims, secret));
    expect(decoded.claims).toEqual(fixture.claims);
    expect(decoded.secretHash).toBe(runnerHash(secret));
    expect(decoded).not.toHaveProperty("authenticated");
  });
  it("matches the language-neutral domain-separated transcript vector", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("../../../protocol/fixtures/runner-possession.json", import.meta.url),
        "utf8",
      ),
    ) as { challenge: RunnerChallenge; transcript: string; transcript_sha256: string };
    const actual = new TextDecoder().decode(runnerChallengeTranscript(fixture.challenge));
    expect(actual).toBe(fixture.transcript);
    expect(runnerHash(actual)).toBe(fixture.transcript_sha256);
  });
  it.each([
    "workspace",
    "runner",
    "audience",
    "origin",
    "thumbprint",
    "purpose",
    "nonce",
    "issued-at",
    "expiry",
    "epoch",
    "grant",
    "token-epoch",
  ])("rejects a signature over altered %s transcript", async (fault) => {
    const f = await fixture();
    await f.enroll();
    const challenge = await f.challenge();
    const changes: Record<string, Partial<RunnerChallenge>> = {
      workspace: { workspace_id: randomUlid() },
      runner: { runner_id: randomUlid() },
      audience: { audience: "other" as "bfb-runner" },
      origin: { origin: "https://other.test" },
      thumbprint: { public_key_thumbprint: `sha256:${"0".repeat(64)}` },
      purpose: { purpose: "request" },
      nonce: { server_nonce: runnerSecret() },
      "issued-at": { issued_at: "2026-09-11T19:59:59.000Z" },
      expiry: { expires_at: "2026-09-11T20:02:00.000Z" },
      epoch: { authorization_epoch: 4 },
      grant: { grant_epoch: 9 },
      "token-epoch": { token_epoch: 10 },
    };
    const signed = await f.proof({ ...challenge, ...changes[fault] });
    expect(
      (
        await f.native(exchangeRunnerTokenCommand, {
          ...signed,
          tokenSecretHash: runnerHash(runnerSecret()),
        })
      ).ok,
    ).toBe(false);
  });

  it("requires fresh possession for each token, rejects race losers, and fences old tokens", async () => {
    const f = await fixture();
    await f.enroll();
    const challenges = await Promise.all([f.challenge(), f.challenge()]);
    const outcomes = await Promise.all(
      challenges.map(async (challenge) =>
        f.native(exchangeRunnerTokenCommand, {
          ...(await f.proof(challenge)),
          tokenSecretHash: runnerHash(runnerSecret()),
        }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    const issued = await f.token();
    expect(issued.issued.claims.token_epoch).toBe(2);
    expect(
      (
        await f.native(exchangeRunnerTokenCommand, {
          ...issued.signed,
          tokenSecretHash: runnerHash(runnerSecret()),
        })
      ).ok,
    ).toBe(false);
    const renewed = await f.token();
    expect(renewed.issued.claims.jti).not.toBe(issued.issued.claims.jti);
    expect(renewed.issued.claims.token_epoch).toBe(3);
    const binding = {
      method: "POST",
      path: `/runner/workspaces/${FIX.workspace}/runners/${f.runner}/authenticate`,
      body_sha256: runnerHash(""),
    };
    expect(
      (
        await f.native(issueRunnerChallengeCommand, {
          runnerId: f.runner,
          origin: ORIGIN,
          nonceHash: runnerHash(runnerSecret()),
          purpose: "request",
          token: issued.token,
          request: binding,
        })
      ).ok,
    ).toBe(false);
  });

  it("binds authenticated requests to the token, method, path and business body; bearer alone is insufficient", async () => {
    const f = await fixture();
    await f.enroll();
    const issued = await f.token();
    const binding = {
      method: "POST",
      path: `/runner/workspaces/${FIX.workspace}/runners/${f.runner}/events`,
      body_sha256: runnerHash("bounded-event"),
    };
    const challenge = await f.challenge({
      purpose: "request",
      token: issued.token,
      request: binding,
    });
    const proof = await f.proof(challenge);
    for (const altered of [
      { ...binding, method: "DELETE" },
      { ...binding, path: binding.path.replace(/events$/, "commands") },
      { ...binding, body_sha256: runnerHash("other") },
    ]) {
      expect(
        (
          await f.native(authenticateRunnerRequestCommand, {
            ...proof,
            token: issued.token,
            request: altered,
          })
        ).ok,
      ).toBe(false);
    }
    expect(
      (
        await f.native(authenticateRunnerRequestCommand, {
          ...proof,
          signature: "",
          token: issued.token,
          request: binding,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await f.native(authenticateRunnerRequestCommand, {
          ...proof,
          token: issued.token + "x",
          request: binding,
        })
      ).ok,
    ).toBe(false);
    const principal = result(
      await f.native(authenticateRunnerRequestCommand, {
        ...proof,
        token: issued.token,
        request: binding,
      }),
    );
    expect(principal.kind).toBe("runner");
    expect(principal.projectIds).toEqual([FIX.projectA]);
    expect(
      (
        await f.native(authenticateRunnerRequestCommand, {
          ...proof,
          token: issued.token,
          request: binding,
        })
      ).ok,
    ).toBe(false);
  });

  it("uses server time and fails closed for expired/future challenges and expired tokens", async () => {
    const f = await fixture();
    await f.enroll();
    const challenge = await f.challenge();
    const signed = await f.proof(challenge);
    for (const now of ["2026-09-11T20:01:00.000Z", "2026-09-11T19:59:59.000Z"]) {
      expect(
        (
          await f.native(
            exchangeRunnerTokenCommand,
            { ...signed, tokenSecretHash: runnerHash(runnerSecret()) },
            now,
          )
        ).ok,
      ).toBe(false);
    }
    const issued = await f.token();
    expect(
      (
        await f.native(
          issueRunnerChallengeCommand,
          {
            runnerId: f.runner,
            origin: ORIGIN,
            purpose: "request",
            nonceHash: runnerHash(runnerSecret()),
            token: issued.token,
            request: {
              method: "GET",
              path: `/runner/workspaces/${FIX.workspace}/runners/${f.runner}/channel`,
              body_sha256: runnerHash(""),
            },
          },
          "2026-09-11T20:05:00.000Z",
        )
      ).ok,
    ).toBe(false);
  });

  it("never persists raw challenge nonces, signatures, secrets, tokens, or step-up proof inputs in audit", async () => {
    const f = await fixture();
    await f.enroll();
    const issued = await f.token();
    for (const table of [
      "runners",
      "runner_challenges",
      "runner_tokens",
      "semantic_events",
      "audit_events",
      "outbox_records",
      "idempotency_records",
    ]) {
      const dump = JSON.stringify(await f.db.prepare(`SELECT * FROM ${table}`).all());
      for (const secret of [
        issued.signed.serverNonce,
        issued.signed.signature,
        issued.secret,
        issued.token,
      ])
        expect(dump).not.toContain(secret);
      expect(dump).not.toContain("stepUpProofId");
    }
    expect(
      await f.db.prepare(`SELECT COUNT(*) AS count FROM runner_mutation_guards`).get(),
    ).toEqual({ count: 0 });
  });
});

describe("runner sharing and revocation", () => {
  it("does not resurrect a removed member's old Mac launch grant when they rejoin", async () => {
    const f = await fixture();
    await f.enroll();
    const sharing = {
      runnerId: f.runner,
      expectedGrantEpoch: 1,
      projectIds: [FIX.projectA],
      launcherHumanIds: [FIX.owner, FIX.member],
    };
    const proof = await f.step("runner.grants.replace", runnerGrantsTarget(sharing));
    result(await f.human(replaceRunnerGrantsCommand, { ...sharing, stepUpProofId: proof }));
    result(await f.human(removeMemberCommand, { humanId: FIX.member }));
    await f.db
      .prepare(
        `INSERT INTO workspace_members (workspace_id, human_id, role, authorization_epoch, created_at) VALUES (?, ?, 'member', 3, ?)`,
      )
      .run(FIX.workspace, FIX.member, NOW);
    await f.db
      .prepare(
        `UPDATE workspace_authorization_epochs SET authorization_epoch = 3, revoked_at = NULL WHERE workspace_id = ? AND human_id = ?`,
      )
      .run(FIX.workspace, FIX.member);
    await f.db
      .prepare(`INSERT INTO project_access (workspace_id, project_id, human_id) VALUES (?, ?, ?)`)
      .run(FIX.workspace, FIX.projectA, FIX.member);
    const rejoined = await loadPrincipal(f.db, FIX.workspace, FIX.member);
    await expect(
      assertRunnerLaunchAuthority(f.db, rejoined, f.runner, FIX.projectA),
    ).rejects.toThrow();
  });
  it("requires a fresh exact sharing proof for expansion and removal and disables old credentials before cleanup", async () => {
    const f = await fixture();
    await f.enroll();
    const issued = await f.token();
    const input = {
      runnerId: f.runner,
      expectedGrantEpoch: 1,
      projectIds: [FIX.projectA],
      launcherHumanIds: [FIX.owner, FIX.member],
    };
    const wrong = await f.step("runner.enroll", runnerGrantsTarget(input));
    expect((await f.human(replaceRunnerGrantsCommand, { ...input, stepUpProofId: wrong })).ok).toBe(
      false,
    );
    const proof = await f.step("runner.grants.replace", runnerGrantsTarget(input));
    const expanded = result(
      await f.human(replaceRunnerGrantsCommand, { ...input, stepUpProofId: proof }),
    );
    expect(expanded.runner.grant_epoch).toBe(2);
    const member = await loadPrincipal(f.db, FIX.workspace, FIX.member);
    await expect(
      assertRunnerLaunchAuthority(f.db, member, f.runner, FIX.projectA),
    ).resolves.toBeUndefined();
    const removal = { ...input, expectedGrantEpoch: 2, launcherHumanIds: [FIX.owner] };
    expect(
      (await f.human(replaceRunnerGrantsCommand, { ...removal, stepUpProofId: proof })).ok,
    ).toBe(false);
    const removeProof = await f.step("runner.grants.replace", runnerGrantsTarget(removal));
    const removed = result(
      await f.human(replaceRunnerGrantsCommand, { ...removal, stepUpProofId: removeProof }),
    );
    expect(removed.signals[0]).toMatchObject({
      kind: "runner.channel.close",
      reason: "grants_changed",
      removed_human_id: FIX.member,
      grant_epoch: 3,
    });
    await expect(
      assertRunnerLaunchAuthority(f.db, member, f.runner, FIX.projectA),
    ).rejects.toThrow();
    const fresh = await f.token();
    expect(fresh.issued.claims.grant_epoch).toBe(3);
    const pending = await f.challenge();
    const revoke = await f.step("runner.revoke", f.runner);
    const revoked = result(
      await f.human(revokeRunnerCommand, { runnerId: f.runner, stepUpProofId: revoke }),
    );
    expect(revoked.signal).toMatchObject({
      kind: "runner.channel.close",
      reason: "revoked",
      authorization_epoch: 2,
      grant_epoch: 4,
    });
    expect(
      (
        await f.native(exchangeRunnerTokenCommand, {
          ...(await f.proof(pending)),
          tokenSecretHash: runnerHash(runnerSecret()),
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await f.native(issueRunnerChallengeCommand, {
          runnerId: f.runner,
          origin: ORIGIN,
          purpose: "token",
          nonceHash: runnerHash(runnerSecret()),
        })
      ).ok,
    ).toBe(false);
    const retained = await f.db
      .prepare(`SELECT token_hash, revoked_at FROM runner_tokens WHERE id = ?`)
      .get(issued.issued.claims.jti);
    expect(retained).toEqual({ token_hash: runnerHash(issued.secret), revoked_at: null });
    expect(
      await f.db
        .prepare(`SELECT COUNT(*) AS count FROM runner_channel_signals WHERE reason = 'revoked'`)
        .get(),
    ).toEqual({ count: 1 });
  });

  it("invalidates tokens and outstanding challenges when owner membership epoch changes", async () => {
    const f = await fixture();
    await f.enroll();
    const issued = await f.token();
    const pending = await f.challenge();
    await f.db
      .prepare(
        `UPDATE workspace_members SET authorization_epoch = 2 WHERE workspace_id = ? AND human_id = ?`,
      )
      .run(FIX.workspace, FIX.owner);
    await f.db
      .prepare(
        `UPDATE workspace_authorization_epochs SET authorization_epoch = 2 WHERE workspace_id = ? AND human_id = ?`,
      )
      .run(FIX.workspace, FIX.owner);
    expect(
      (
        await f.native(exchangeRunnerTokenCommand, {
          ...(await f.proof(pending)),
          tokenSecretHash: runnerHash(runnerSecret()),
        })
      ).ok,
    ).toBe(false);
    const renewed = await f.token();
    expect(renewed.issued.claims.owner_authorization_epoch).toBe(2);
    expect(renewed.token).not.toBe(issued.token);
    await f.db
      .prepare(
        `UPDATE workspace_authorization_epochs SET revoked_at = ? WHERE workspace_id = ? AND human_id = ?`,
      )
      .run(NOW, FIX.workspace, FIX.owner);
    expect(
      (
        await f.native(issueRunnerChallengeCommand, {
          runnerId: f.runner,
          origin: ORIGIN,
          purpose: "token",
          nonceHash: runnerHash(runnerSecret()),
        })
      ).ok,
    ).toBe(false);
  });
});

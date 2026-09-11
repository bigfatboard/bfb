// ABOUTME: Owns runner enrollment, named-human grants, single-use possession proofs, and revocation.
// ABOUTME: WorkspaceHub batches serialize authority changes while guarded SQL rejects raced capabilities.

import type { SqlDatabase } from "@bfb/db";

import { assertEpoch, assertRole, loadPrincipal, type AuthzPrincipal } from "./authorization.js";
import type { HubCommand, HubContext } from "./hub.js";
import { randomUlid } from "./ids.js";
import {
  canonicalRunnerKey,
  decodeRunnerToken,
  rejectRunnerRequest,
  runnerDigest,
  runnerHash,
  runnerHashEqual,
  runnerId,
  runnerKeyThumbprint,
  runnerObject,
  runnerRequestBinding,
  RUNNER_AUDIENCE,
  RUNNER_CHALLENGE_TTL_MS,
  RUNNER_TOKEN_TTL_MS,
  verifyRunnerSignature,
  type RunnerChallenge,
  type RunnerPublicKey,
  type RunnerRequestBinding,
  type RunnerTokenClaims,
} from "./runner-crypto.js";
import { validateStepUpProof, type StepUpAction } from "./step-up.js";

/** Named internal issuer: requesting a challenge is not authenticated runner activity. */
export const RUNNER_CHALLENGE_ISSUER_ID = "01K00000000000000000000006";

export interface EnrollRunnerInput {
  runnerId: string;
  deviceLabel: string;
  publicKey: RunnerPublicKey;
  projectIds: string[];
  stepUpProofId: string;
}

export interface RunnerGrantsInput {
  runnerId: string;
  expectedGrantEpoch: number;
  projectIds: string[];
  launcherHumanIds: string[];
  stepUpProofId: string;
}

export interface RunnerSummary {
  schema_version: 1;
  runner_id: string;
  workspace_id: string;
  owner_human_id: string;
  device_label: string;
  public_key_thumbprint: string;
  authorization_epoch: number;
  grant_epoch: number;
  status: "enrolled" | "revoked";
  enrolled_at: string;
  granted_project_ids: string[];
  launcher_human_ids: string[];
}

interface RunnerRow {
  workspace_id: string;
  id: string;
  owner_human_id: string;
  device_label: string;
  public_key_json: string;
  key_thumbprint: string;
  authorization_epoch: number;
  grant_epoch: number;
  token_epoch: number;
  enrolled_at: string;
  revoked_at: string | null;
}

interface ChallengeRow {
  id: string;
  workspace_id: string;
  runner_id: string;
  nonce_hash: string;
  purpose: "token" | "request";
  audience: typeof RUNNER_AUDIENCE;
  origin: string;
  authorization_epoch: number;
  owner_authorization_epoch: number;
  grant_epoch: number;
  token_epoch: number;
  token_id: string | null;
  request_json: string | null;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface RunnerPrincipal {
  kind: "runner";
  runnerId: string;
  workspaceId: string;
  ownerHumanId: string;
  authorizationEpoch: number;
  ownerAuthorizationEpoch: number;
  grantEpoch: number;
  tokenEpoch: number;
  tokenId: string;
  keyThumbprint: string;
  authExpiresAt: string;
  projectIds: string[];
}

export interface RunnerChannelCloseSignal {
  schema_version: 1;
  kind: "runner.channel.close";
  signal_id: string;
  workspace_id: string;
  runner_id: string;
  authorization_epoch: number;
  grant_epoch: number;
  reason: "revoked" | "grants_changed" | "token_rotated";
  token_epoch: number;
  removed_human_id: string | null;
  created_at: string;
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) rejectRunnerRequest();
  const result = value.map(runnerId).sort();
  if (new Set(result).size !== result.length) rejectRunnerRequest();
  return result;
}

function label(value: unknown): string {
  // Device labels are display metadata, never paths or free-form machine configuration.
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 80 ||
    value.trim() !== value ||
    !/^[\p{L}\p{N}][\p{L}\p{N} ._()'-]*$/u.test(value)
  )
    rejectRunnerRequest();
  return value;
}

async function human(ctx: HubContext): Promise<AuthzPrincipal> {
  if (!ctx.actorHumanId || ctx.actorDelegationId || ctx.actorRunnerId || ctx.actorSystemId)
    rejectRunnerRequest();
  const principal = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
  assertRole(principal, ["owner", "member"]);
  assertEpoch(principal, ctx.authorizationEpoch);
  return principal;
}

async function row(db: SqlDatabase, workspaceId: string, runner: string): Promise<RunnerRow> {
  runnerId(workspaceId);
  runnerId(runner);
  const result = (await db
    .prepare(`SELECT * FROM runners WHERE workspace_id = ? AND id = ?`)
    .get(workspaceId, runner)) as RunnerRow | undefined;
  if (!result) rejectRunnerRequest();
  return result;
}

async function activeRunner(
  ctx: HubContext,
  runner: string,
): Promise<{ runner: RunnerRow; owner: AuthzPrincipal }> {
  const current = await row(ctx.db, ctx.workspaceId, runner);
  if (current.revoked_at) rejectRunnerRequest();
  const owner = await loadPrincipal(ctx.db, ctx.workspaceId, current.owner_human_id);
  assertRole(owner, ["owner", "member"]);
  return { runner: current, owner };
}

async function projectIds(db: SqlDatabase, workspaceId: string, runner: string): Promise<string[]> {
  return (
    (await db
      .prepare(
        `SELECT project_id FROM runner_project_grants WHERE workspace_id = ? AND runner_id = ? ORDER BY project_id`,
      )
      .all(workspaceId, runner)) as { project_id: string }[]
  ).map((item) => item.project_id);
}

async function launcherIds(
  db: SqlDatabase,
  workspaceId: string,
  runner: string,
): Promise<string[]> {
  return (
    (await db
      .prepare(
        `SELECT human_id FROM runner_launch_grants WHERE workspace_id = ? AND runner_id = ? AND revoked_at IS NULL ORDER BY human_id`,
      )
      .all(workspaceId, runner)) as { human_id: string }[]
  ).map((item) => item.human_id);
}

function summary(current: RunnerRow, projects: string[], launchers: string[]): RunnerSummary {
  return {
    schema_version: 1,
    runner_id: current.id,
    workspace_id: current.workspace_id,
    owner_human_id: current.owner_human_id,
    device_label: current.device_label,
    public_key_thumbprint: current.key_thumbprint,
    authorization_epoch: current.authorization_epoch,
    grant_epoch: current.grant_epoch,
    status: current.revoked_at ? "revoked" : "enrolled",
    enrolled_at: current.enrolled_at,
    granted_project_ids: projects,
    launcher_human_ids: launchers,
  };
}

/** Predicate SQL is compiled by this module, never provided by a caller. */
async function guard(db: SqlDatabase, predicate: string, params: unknown[]): Promise<void> {
  const guardId = randomUlid();
  await db
    .prepare(`INSERT INTO runner_mutation_guards (id, valid) VALUES (?, (${predicate}))`)
    .run(guardId, ...params);
  await db.prepare(`DELETE FROM runner_mutation_guards WHERE id = ?`).run(guardId);
}

export function runnerEnrollmentTarget(input: Omit<EnrollRunnerInput, "stepUpProofId">): string {
  return `sha256:${runnerHash(JSON.stringify(["runner.enroll", runnerId(input.runnerId), label(input.deviceLabel), runnerKeyThumbprint(input.publicKey), ids(input.projectIds)]))}`;
}

export function runnerGrantsTarget(input: Omit<RunnerGrantsInput, "stepUpProofId">): string {
  return `sha256:${runnerHash(JSON.stringify(["runner.grants.replace", runnerId(input.runnerId), input.expectedGrantEpoch, ids(input.projectIds), ids(input.launcherHumanIds)]))}`;
}

async function prepareStepUp(
  ctx: HubContext,
  proofId: string,
  action: string,
  targetId: string,
): Promise<() => Promise<void>> {
  runnerId(proofId);
  const proof = (await ctx.db
    .prepare(`SELECT expires_at FROM passkey_step_up_proofs WHERE proof_id = ?`)
    .get(proofId)) as { expires_at: string } | undefined;
  if (!proof || !ctx.actorHumanId) rejectRunnerRequest();
  const expected: StepUpAction = {
    action,
    workspaceId: ctx.workspaceId,
    targetId,
    scopes: [],
    authorizationEpoch: ctx.authorizationEpoch,
    expiresAt: proof.expires_at,
  };
  await validateStepUpProof(ctx.db, proofId, expected, ctx.now, ctx.actorHumanId);
  const stamp = randomUlid();
  return async () => {
    await ctx.db
      .prepare(
        `UPDATE passkey_step_up_proofs SET consumed_at = ? WHERE proof_id = ? AND consumed_at IS NULL AND expires_at > ?`,
      )
      .run(stamp, proofId, ctx.now);
    await guard(
      ctx.db,
      `SELECT COUNT(*) = 1 FROM passkey_step_up_proofs WHERE proof_id = ? AND consumed_at = ?`,
      [proofId, stamp],
    );
  };
}

export const enrollRunnerCommand: HubCommand<EnrollRunnerInput, RunnerSummary> = {
  name: "runner.enroll",
  replay: "reject",
  auditInput: (input) => ({ runnerId: input.runnerId }),
  async run(input, ctx) {
    runnerObject(input, ["runnerId", "deviceLabel", "publicKey", "projectIds", "stepUpProofId"]);
    const principal = await human(ctx);
    const publicKey = await canonicalRunnerKey(input.publicKey);
    const projects = ids(input.projectIds);
    if (projects.some((id) => !principal.projectIds.includes(id))) rejectRunnerRequest();
    const current: RunnerRow = {
      workspace_id: ctx.workspaceId,
      id: runnerId(input.runnerId),
      owner_human_id: principal.humanId,
      device_label: label(input.deviceLabel),
      public_key_json: JSON.stringify(publicKey),
      key_thumbprint: runnerKeyThumbprint(publicKey),
      authorization_epoch: 1,
      grant_epoch: 1,
      token_epoch: 0,
      enrolled_at: ctx.now,
      revoked_at: null,
    };
    const consume = await prepareStepUp(
      ctx,
      input.stepUpProofId,
      "runner.enroll",
      runnerEnrollmentTarget({ ...input, publicKey }),
    );
    await consume();
    await ctx.db
      .prepare(
        `INSERT INTO runners (workspace_id, id, owner_human_id, device_label, public_key_json, key_thumbprint, enrolled_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        current.id,
        current.owner_human_id,
        current.device_label,
        current.public_key_json,
        current.key_thumbprint,
        ctx.now,
      );
    for (const project of projects) {
      await ctx.db
        .prepare(
          `INSERT INTO runner_project_grants (workspace_id, runner_id, project_id) VALUES (?, ?, ?)`,
        )
        .run(ctx.workspaceId, current.id, project);
    }
    await ctx.db
      .prepare(
        `INSERT INTO runner_launch_grants (workspace_id, runner_id, human_id, granted_at) VALUES (?, ?, ?, ?)`,
      )
      .run(ctx.workspaceId, current.id, principal.humanId, ctx.now);
    return summary(current, projects, [principal.humanId]);
  },
};

async function signal(
  ctx: HubContext,
  current: RunnerRow,
  reason: RunnerChannelCloseSignal["reason"],
  removedHuman: string | null = null,
): Promise<RunnerChannelCloseSignal> {
  const result: RunnerChannelCloseSignal = {
    schema_version: 1,
    kind: "runner.channel.close",
    signal_id: randomUlid(),
    workspace_id: ctx.workspaceId,
    runner_id: current.id,
    authorization_epoch: current.authorization_epoch,
    grant_epoch: current.grant_epoch,
    token_epoch: current.token_epoch,
    reason,
    removed_human_id: removedHuman,
    created_at: ctx.now,
  };
  await ctx.db
    .prepare(
      `INSERT INTO runner_channel_signals (workspace_id, runner_id, id, authorization_epoch, grant_epoch, token_epoch, reason, removed_human_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ctx.workspaceId,
      current.id,
      result.signal_id,
      result.authorization_epoch,
      result.grant_epoch,
      result.token_epoch,
      reason,
      removedHuman,
      ctx.now,
    );
  return result;
}

export const replaceRunnerGrantsCommand: HubCommand<
  RunnerGrantsInput,
  { runner: RunnerSummary; signals: RunnerChannelCloseSignal[] }
> = {
  name: "runner.grants.replace",
  replay: "reject",
  auditInput: (input) => ({ runnerId: input.runnerId }),
  async run(input, ctx) {
    runnerObject(input, [
      "runnerId",
      "expectedGrantEpoch",
      "projectIds",
      "launcherHumanIds",
      "stepUpProofId",
    ]);
    const principal = await human(ctx);
    const current = await row(ctx.db, ctx.workspaceId, input.runnerId);
    if (
      current.revoked_at ||
      current.owner_human_id !== principal.humanId ||
      current.grant_epoch !== input.expectedGrantEpoch
    )
      rejectRunnerRequest();
    const projects = ids(input.projectIds);
    const launchers = ids(input.launcherHumanIds);
    if (
      !launchers.includes(principal.humanId) ||
      projects.some((id) => !principal.projectIds.includes(id))
    )
      rejectRunnerRequest();
    for (const launcher of launchers) {
      assertRole(await loadPrincipal(ctx.db, ctx.workspaceId, launcher), ["owner", "member"]);
    }
    const previous = await launcherIds(ctx.db, ctx.workspaceId, current.id);
    const consume = await prepareStepUp(
      ctx,
      input.stepUpProofId,
      "runner.grants.replace",
      runnerGrantsTarget(input),
    );
    await consume();
    await guard(
      ctx.db,
      `SELECT COUNT(*) = 1 FROM runners WHERE workspace_id = ? AND id = ? AND grant_epoch = ? AND revoked_at IS NULL`,
      [ctx.workspaceId, current.id, current.grant_epoch],
    );
    current.grant_epoch += 1;
    await ctx.db
      .prepare(`UPDATE runners SET grant_epoch = ? WHERE workspace_id = ? AND id = ?`)
      .run(current.grant_epoch, ctx.workspaceId, current.id);
    await ctx.db
      .prepare(`DELETE FROM runner_project_grants WHERE workspace_id = ? AND runner_id = ?`)
      .run(ctx.workspaceId, current.id);
    for (const project of projects)
      await ctx.db
        .prepare(
          `INSERT INTO runner_project_grants (workspace_id, runner_id, project_id) VALUES (?, ?, ?)`,
        )
        .run(ctx.workspaceId, current.id, project);
    await ctx.db
      .prepare(
        `UPDATE runner_launch_grants SET revoked_at = ? WHERE workspace_id = ? AND runner_id = ? AND revoked_at IS NULL`,
      )
      .run(ctx.now, ctx.workspaceId, current.id);
    for (const launcher of launchers)
      await ctx.db
        .prepare(
          `INSERT INTO runner_launch_grants (workspace_id, runner_id, human_id, granted_at, revoked_at) VALUES (?, ?, ?, ?, NULL) ON CONFLICT (workspace_id, runner_id, human_id) DO UPDATE SET granted_at = excluded.granted_at, revoked_at = NULL`,
        )
        .run(ctx.workspaceId, current.id, launcher, ctx.now);
    const removed = previous.filter((id) => !launchers.includes(id));
    const signals: RunnerChannelCloseSignal[] = [];
    for (const removedHuman of removed.length ? removed : [null])
      signals.push(await signal(ctx, current, "grants_changed", removedHuman));
    return { runner: summary(current, projects, launchers), signals };
  },
};

export const revokeRunnerCommand: HubCommand<
  { runnerId: string; stepUpProofId: string },
  { signal: RunnerChannelCloseSignal }
> = {
  name: "runner.revoke",
  replay: "reject",
  auditInput: (input) => ({ runnerId: input.runnerId }),
  async run(input, ctx) {
    runnerObject(input, ["runnerId", "stepUpProofId"]);
    const principal = await human(ctx);
    const current = await row(ctx.db, ctx.workspaceId, input.runnerId);
    if (current.owner_human_id !== principal.humanId || current.revoked_at) rejectRunnerRequest();
    const consume = await prepareStepUp(ctx, input.stepUpProofId, "runner.revoke", current.id);
    await consume();
    current.authorization_epoch += 1;
    current.grant_epoch += 1;
    await ctx.db
      .prepare(
        `UPDATE runners SET revoked_at = ?, authorization_epoch = ?, grant_epoch = ? WHERE workspace_id = ? AND id = ?`,
      )
      .run(ctx.now, current.authorization_epoch, current.grant_epoch, ctx.workspaceId, current.id);
    await ctx.db
      .prepare(
        `UPDATE runner_launch_grants SET revoked_at = ? WHERE workspace_id = ? AND runner_id = ? AND revoked_at IS NULL`,
      )
      .run(ctx.now, ctx.workspaceId, current.id);
    return { signal: await signal(ctx, current, "revoked") };
  },
};

export interface IssueRunnerChallengeInput {
  runnerId: string;
  nonceHash: string;
  origin: string;
  purpose: "token" | "request";
  token?: string;
  request?: RunnerRequestBinding;
}

function origin(value: unknown): string {
  if (typeof value !== "string" || value.length > 256) rejectRunnerRequest();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    rejectRunnerRequest();
  }
  if (
    url.origin !== value ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    rejectRunnerRequest();
  return value;
}

function runnerActor(ctx: HubContext, runner: string): void {
  if (
    ctx.actorRunnerId !== runner ||
    ctx.actorHumanId ||
    ctx.actorDelegationId ||
    ctx.actorSystemId
  )
    rejectRunnerRequest();
}

async function tokenClaims(
  ctx: HubContext,
  current: RunnerRow,
  owner: AuthzPrincipal,
  token: unknown,
  expectedOrigin: string,
): Promise<RunnerTokenClaims> {
  const presented = decodeRunnerToken(token);
  const claims = presented.claims;
  const stored = (await ctx.db
    .prepare(
      `SELECT token_hash, claims_json, revoked_at FROM runner_tokens WHERE workspace_id = ? AND runner_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, current.id, claims.jti)) as
    { token_hash: string; claims_json: string; revoked_at: string | null } | undefined;
  const now = Math.floor(Date.parse(ctx.now) / 1000);
  if (
    !stored ||
    stored.revoked_at ||
    stored.claims_json !== presented.claimsJson ||
    !runnerHashEqual(stored.token_hash, presented.secretHash) ||
    claims.sub !== current.id ||
    claims.workspace_id !== ctx.workspaceId ||
    claims.iss !== expectedOrigin ||
    claims.authorization_epoch !== current.authorization_epoch ||
    claims.owner_authorization_epoch !== owner.authorizationEpoch ||
    claims.grant_epoch !== current.grant_epoch ||
    claims.token_epoch !== current.token_epoch ||
    claims.cnf.jkt !== current.key_thumbprint ||
    claims.iat > now ||
    claims.exp <= now ||
    claims.exp - claims.iat > RUNNER_TOKEN_TTL_MS / 1000
  )
    rejectRunnerRequest();
  return claims;
}

export const issueRunnerChallengeCommand: HubCommand<
  IssueRunnerChallengeInput,
  Omit<RunnerChallenge, "server_nonce">
> = {
  name: "runner.challenge.issue",
  replay: "reject",
  auditInput: (input) => ({ runnerId: input.runnerId, purpose: input.purpose }),
  async run(input, ctx) {
    runnerObject(input, ["runnerId", "nonceHash", "origin", "purpose", "token", "request"]);
    if (
      ctx.actorSystemId !== RUNNER_CHALLENGE_ISSUER_ID ||
      ctx.actorHumanId ||
      ctx.actorRunnerId ||
      ctx.actorDelegationId
    )
      rejectRunnerRequest();
    runnerDigest(input.nonceHash);
    const { runner: current, owner } = await activeRunner(ctx, input.runnerId);
    const expectedOrigin = origin(input.origin);
    let token: RunnerTokenClaims | null = null;
    let binding: RunnerRequestBinding | null = null;
    if (input.purpose === "request") {
      token = await tokenClaims(ctx, current, owner, input.token, expectedOrigin);
      binding = runnerRequestBinding(input.request, ctx.workspaceId, current.id);
    } else if (
      input.purpose !== "token" ||
      input.token !== undefined ||
      input.request !== undefined
    )
      rejectRunnerRequest();
    const result: Omit<RunnerChallenge, "server_nonce"> = {
      schema_version: 1,
      challenge_id: randomUlid(),
      workspace_id: ctx.workspaceId,
      runner_id: current.id,
      audience: RUNNER_AUDIENCE,
      origin: expectedOrigin,
      public_key_thumbprint: current.key_thumbprint,
      purpose: input.purpose,
      authorization_epoch: current.authorization_epoch,
      owner_authorization_epoch: owner.authorizationEpoch,
      grant_epoch: current.grant_epoch,
      token_epoch: current.token_epoch,
      token_id: token?.jti ?? null,
      request: binding,
      issued_at: ctx.now,
      expires_at: new Date(Date.parse(ctx.now) + RUNNER_CHALLENGE_TTL_MS).toISOString(),
    };
    await ctx.db
      .prepare(
        `INSERT INTO runner_challenges (workspace_id, runner_id, id, nonce_hash, purpose, audience, origin, authorization_epoch, owner_authorization_epoch, grant_epoch, token_epoch, token_id, request_json, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        current.id,
        result.challenge_id,
        input.nonceHash,
        input.purpose,
        RUNNER_AUDIENCE,
        expectedOrigin,
        current.authorization_epoch,
        owner.authorizationEpoch,
        current.grant_epoch,
        current.token_epoch,
        result.token_id,
        binding ? JSON.stringify(binding) : null,
        ctx.now,
        result.expires_at,
      );
    return result;
  },
};

export interface RunnerProofInput {
  runnerId: string;
  challengeId: string;
  serverNonce: string;
  signature: string;
  origin: string;
}

async function preparePossession(
  ctx: HubContext,
  input: RunnerProofInput,
  purpose: "token" | "request",
) {
  runnerActor(ctx, input.runnerId);
  runnerId(input.challengeId);
  const { runner: current, owner } = await activeRunner(ctx, input.runnerId);
  if (ctx.authorizationEpoch !== current.authorization_epoch) rejectRunnerRequest();
  const challenge = (await ctx.db
    .prepare(`SELECT * FROM runner_challenges WHERE workspace_id = ? AND runner_id = ? AND id = ?`)
    .get(ctx.workspaceId, current.id, input.challengeId)) as ChallengeRow | undefined;
  const now = Date.parse(ctx.now);
  if (
    !challenge ||
    challenge.consumed_at ||
    challenge.purpose !== purpose ||
    challenge.origin !== origin(input.origin) ||
    typeof input.serverNonce !== "string" ||
    input.serverNonce.length !== 43 ||
    !runnerHashEqual(challenge.nonce_hash, runnerHash(input.serverNonce)) ||
    challenge.authorization_epoch !== current.authorization_epoch ||
    challenge.owner_authorization_epoch !== owner.authorizationEpoch ||
    challenge.grant_epoch !== current.grant_epoch ||
    challenge.token_epoch !== current.token_epoch ||
    Date.parse(challenge.issued_at) > now ||
    Date.parse(challenge.expires_at) <= now
  )
    rejectRunnerRequest();
  const canonical: RunnerChallenge = {
    schema_version: 1,
    challenge_id: challenge.id,
    server_nonce: input.serverNonce,
    workspace_id: ctx.workspaceId,
    runner_id: current.id,
    audience: challenge.audience,
    origin: challenge.origin,
    public_key_thumbprint: current.key_thumbprint,
    purpose,
    authorization_epoch: challenge.authorization_epoch,
    owner_authorization_epoch: challenge.owner_authorization_epoch,
    grant_epoch: challenge.grant_epoch,
    token_epoch: challenge.token_epoch,
    token_id: challenge.token_id,
    request: challenge.request_json
      ? (JSON.parse(challenge.request_json) as RunnerRequestBinding)
      : null,
    issued_at: challenge.issued_at,
    expires_at: challenge.expires_at,
  };
  await verifyRunnerSignature(
    JSON.parse(current.public_key_json) as RunnerPublicKey,
    canonical,
    input.signature,
  );
  const stamp = randomUlid();
  return {
    runner: current,
    owner,
    challenge: canonical,
    async consume() {
      await guard(
        ctx.db,
        `SELECT COUNT(*) = 1 FROM runners AS runner JOIN workspace_authorization_epochs AS owner ON owner.workspace_id = runner.workspace_id AND owner.human_id = runner.owner_human_id WHERE runner.workspace_id = ? AND runner.id = ? AND runner.revoked_at IS NULL AND runner.authorization_epoch = ? AND runner.grant_epoch = ? AND runner.token_epoch = ? AND owner.authorization_epoch = ? AND owner.revoked_at IS NULL`,
        [
          ctx.workspaceId,
          current.id,
          current.authorization_epoch,
          current.grant_epoch,
          current.token_epoch,
          owner.authorizationEpoch,
        ],
      );
      await ctx.db
        .prepare(
          `UPDATE runner_challenges SET consumed_at = ? WHERE workspace_id = ? AND id = ? AND consumed_at IS NULL AND expires_at > ?`,
        )
        .run(stamp, ctx.workspaceId, challenge.id, ctx.now);
      await guard(
        ctx.db,
        `SELECT COUNT(*) = 1 FROM runner_challenges WHERE workspace_id = ? AND id = ? AND consumed_at = ?`,
        [ctx.workspaceId, challenge.id, stamp],
      );
    },
  };
}

export const exchangeRunnerTokenCommand: HubCommand<
  RunnerProofInput & { tokenSecretHash: string },
  { claims: RunnerTokenClaims; signal: RunnerChannelCloseSignal }
> = {
  name: "runner.token.exchange",
  replay: "reject",
  auditInput: (input) => ({ runnerId: input.runnerId, challengeId: input.challengeId }),
  async run(input, ctx) {
    runnerObject(input, [
      "runnerId",
      "challengeId",
      "serverNonce",
      "signature",
      "origin",
      "tokenSecretHash",
    ]);
    runnerDigest(input.tokenSecretHash);
    const proof = await preparePossession(ctx, input, "token");
    const current = proof.runner;
    const claims: RunnerTokenClaims = {
      v: 1,
      sub: current.id,
      workspace_id: ctx.workspaceId,
      aud: RUNNER_AUDIENCE,
      iss: input.origin,
      jti: randomUlid(),
      iat: Math.floor(Date.parse(ctx.now) / 1000),
      exp: Math.floor((Date.parse(ctx.now) + RUNNER_TOKEN_TTL_MS) / 1000),
      authorization_epoch: current.authorization_epoch,
      owner_authorization_epoch: proof.owner.authorizationEpoch,
      grant_epoch: current.grant_epoch,
      token_epoch: current.token_epoch + 1,
      cnf: { jkt: current.key_thumbprint },
    };
    await proof.consume();
    current.token_epoch += 1;
    await ctx.db
      .prepare(`UPDATE runners SET token_epoch = ? WHERE workspace_id = ? AND id = ?`)
      .run(current.token_epoch, ctx.workspaceId, current.id);
    await ctx.db
      .prepare(
        `INSERT INTO runner_tokens (workspace_id, runner_id, id, token_hash, claims_json, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        current.id,
        claims.jti,
        input.tokenSecretHash,
        JSON.stringify(claims),
        new Date(claims.exp * 1000).toISOString(),
      );
    return { claims, signal: await signal(ctx, current, "token_rotated") };
  },
};

export const authenticateRunnerRequestCommand: HubCommand<
  RunnerProofInput & { token: string; request: RunnerRequestBinding },
  RunnerPrincipal
> = {
  name: "runner.request.authenticate",
  replay: "reject",
  auditInput: (input) => ({ runnerId: input.runnerId, challengeId: input.challengeId }),
  async run(input, ctx) {
    runnerObject(input, [
      "runnerId",
      "challengeId",
      "serverNonce",
      "signature",
      "origin",
      "token",
      "request",
    ]);
    const proof = await preparePossession(ctx, input, "request");
    const claims = await tokenClaims(ctx, proof.runner, proof.owner, input.token, input.origin);
    const binding = runnerRequestBinding(input.request, ctx.workspaceId, proof.runner.id);
    if (
      proof.challenge.token_id !== claims.jti ||
      JSON.stringify(binding) !== JSON.stringify(proof.challenge.request)
    )
      rejectRunnerRequest();
    const projects = (await projectIds(ctx.db, ctx.workspaceId, proof.runner.id)).filter((id) =>
      proof.owner.projectIds.includes(id),
    );
    await proof.consume();
    return {
      kind: "runner",
      runnerId: proof.runner.id,
      workspaceId: ctx.workspaceId,
      ownerHumanId: proof.runner.owner_human_id,
      authorizationEpoch: proof.runner.authorization_epoch,
      ownerAuthorizationEpoch: proof.owner.authorizationEpoch,
      grantEpoch: proof.runner.grant_epoch,
      tokenEpoch: proof.runner.token_epoch,
      tokenId: claims.jti,
      keyThumbprint: proof.runner.key_thumbprint,
      authExpiresAt: new Date(claims.exp * 1000).toISOString(),
      projectIds: projects,
    };
  },
};

/** Rechecks a previously verified internal principal; this never authenticates public credentials. */
export async function assertCurrentRunnerPrincipal(
  db: SqlDatabase,
  principal: RunnerPrincipal,
  now: string,
): Promise<RunnerPrincipal> {
  if (principal.kind !== "runner" || !Number.isFinite(Date.parse(now))) rejectRunnerRequest();
  const current = await row(db, principal.workspaceId, principal.runnerId);
  const owner = await loadPrincipal(db, current.workspace_id, current.owner_human_id);
  assertRole(owner, ["owner", "member"]);
  const stored = (await db
    .prepare(
      `SELECT claims_json, expires_at, revoked_at FROM runner_tokens WHERE workspace_id = ? AND runner_id = ? AND id = ?`,
    )
    .get(principal.workspaceId, principal.runnerId, runnerId(principal.tokenId))) as
    { claims_json: string; expires_at: string; revoked_at: string | null } | undefined;
  if (
    !stored ||
    stored.revoked_at ||
    current.revoked_at ||
    principal.ownerHumanId !== current.owner_human_id ||
    principal.authorizationEpoch !== current.authorization_epoch ||
    principal.ownerAuthorizationEpoch !== owner.authorizationEpoch ||
    principal.grantEpoch !== current.grant_epoch ||
    principal.tokenEpoch !== current.token_epoch ||
    principal.keyThumbprint !== current.key_thumbprint ||
    principal.authExpiresAt !== stored.expires_at ||
    Date.parse(stored.expires_at) <= Date.parse(now)
  )
    rejectRunnerRequest();
  const claims = JSON.parse(stored.claims_json) as RunnerTokenClaims;
  if (
    claims.v !== 1 ||
    claims.sub !== principal.runnerId ||
    claims.workspace_id !== principal.workspaceId ||
    claims.aud !== "bfb-runner" ||
    claims.jti !== principal.tokenId ||
    claims.iat > Math.floor(Date.parse(now) / 1000) ||
    claims.authorization_epoch !== current.authorization_epoch ||
    claims.owner_authorization_epoch !== owner.authorizationEpoch ||
    claims.grant_epoch !== current.grant_epoch ||
    claims.token_epoch !== current.token_epoch ||
    claims.cnf.jkt !== current.key_thumbprint ||
    claims.exp * 1000 !== Date.parse(stored.expires_at)
  )
    rejectRunnerRequest();
  return {
    ...principal,
    projectIds: (await projectIds(db, principal.workspaceId, principal.runnerId)).filter((id) =>
      owner.projectIds.includes(id),
    ),
  };
}

/** C09 must call this again at creation, claim, and final authorization; a snapshot is not a grant. */
export async function assertRunnerLaunchAuthority(
  db: SqlDatabase,
  principal: AuthzPrincipal,
  runner: string,
  project: string,
): Promise<void> {
  const current = await row(db, principal.workspaceId, runner);
  const fresh = await loadPrincipal(db, principal.workspaceId, principal.humanId);
  assertEpoch(fresh, principal.authorizationEpoch);
  assertRole(fresh, ["owner", "member"]);
  const owner = await loadPrincipal(db, principal.workspaceId, current.owner_human_id);
  assertRole(owner, ["owner", "member"]);
  if (
    current.revoked_at ||
    !fresh.projectIds.includes(project) ||
    !owner.projectIds.includes(project) ||
    !(await projectIds(db, principal.workspaceId, runner)).includes(project) ||
    !(await launcherIds(db, principal.workspaceId, runner)).includes(principal.humanId)
  )
    rejectRunnerRequest();
}

export async function listRunners(
  db: SqlDatabase,
  principal: AuthzPrincipal,
): Promise<RunnerSummary[]> {
  const fresh = await loadPrincipal(db, principal.workspaceId, principal.humanId);
  assertEpoch(fresh, principal.authorizationEpoch);
  const rows = (await db
    .prepare(
      `SELECT runner.* FROM runners AS runner JOIN runner_launch_grants AS grant ON grant.workspace_id = runner.workspace_id AND grant.runner_id = runner.id WHERE runner.workspace_id = ? AND grant.human_id = ? AND (grant.revoked_at IS NULL OR runner.owner_human_id = ?) ORDER BY runner.id LIMIT 100`,
    )
    .all(principal.workspaceId, principal.humanId, principal.humanId)) as RunnerRow[];
  const results: RunnerSummary[] = [];
  for (const current of rows) {
    const projects = await projectIds(db, principal.workspaceId, current.id);
    const ownsRunner = current.owner_human_id === principal.humanId;
    results.push(
      summary(
        current,
        ownsRunner ? projects : projects.filter((id) => fresh.projectIds.includes(id)),
        ownsRunner ? await launcherIds(db, principal.workspaceId, current.id) : [principal.humanId],
      ),
    );
  }
  return results;
}

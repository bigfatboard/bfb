// ABOUTME: Owns action-bound passkey enrollment, step-up, removal, and audit state.
// ABOUTME: WebAuthn verification requires the exact BFB origin, RP ID, session, and user verification.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";

import type { SqlDatabase } from "@bfb/db";
import {
  consumeStepUpProof,
  DomainError,
  issueStepUpProof,
  randomUlid,
  type StepUpAction,
} from "@bfb/domain";

import type { BrowserPrincipal } from "./session.js";

const CEREMONY_TTL_SECONDS = 5 * 60;
const MAX_ACTION_LENGTH = 128;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_SCOPE_COUNT = 16;
const MAX_SCOPE_LENGTH = 128;
const ACTION_PATTERN = /^[a-z][a-z0-9_.:-]{0,127}$/;

export const INITIAL_ENROLLMENT_ACTION = "passkey.enroll.initial";
export const ADDITIONAL_ENROLLMENT_ACTION = "passkey.enroll.additional";
export const REMOVE_PASSKEY_ACTION = "passkey.remove";

export interface StepUpActionRequest {
  action: string;
  clientId?: string | undefined;
  resource?: string | undefined;
  workspaceId?: string | undefined;
  projectId?: string | undefined;
  taskId?: string | undefined;
  targetId?: string | undefined;
  scopes: string[];
  authorizationEpoch: number;
}

export interface EnrollmentFlow {
  flowId: string;
  callbackUrl?: string | undefined;
  requiresReauthentication: boolean;
}

interface CeremonyRow {
  id: string;
  human_id: string;
  auth_user_id: string;
  session_id: string;
  kind: "registration" | "authentication";
  state: "reauth_pending" | "ready" | "challenge_issued" | "failed" | "consumed";
  action_json: string;
  passkey_name: string | null;
  completion_hash: string | null;
  challenge: string | null;
  created_at: string;
  reauthenticated_at: string | null;
  expires_at: string;
  terminal_stamp: string | null;
}

interface StoredPasskey {
  id: string;
  name: string | null;
  public_key: string;
  user_id: string;
  credential_id: string;
  counter: number;
  device_type: "singleDevice" | "multiDevice";
  backed_up: number;
  transports: string | null;
  created_at: string | null;
  aaguid: string | null;
}

export class PasskeyFlowError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new PasskeyFlowError("invalid_time", "invalid passkey flow timestamp");
  }
  return parsed;
}

function expiresAt(nowIso: string): string {
  return new Date(timestamp(nowIso) + CEREMONY_TTL_SECONDS * 1000).toISOString();
}

function requiredString(value: unknown, name: string, maxLength = MAX_IDENTIFIER_LENGTH): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new PasskeyFlowError("invalid_action", `${name} is invalid`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requiredString(value, name);
}

export function normalizeStepUpAction(input: unknown, nowIso: string): StepUpAction {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PasskeyFlowError("invalid_action", "step-up action is invalid");
  }
  const candidate = input as Record<string, unknown>;
  const action = requiredString(candidate.action, "action", MAX_ACTION_LENGTH);
  if (!ACTION_PATTERN.test(action)) {
    throw new PasskeyFlowError("invalid_action", "action is invalid");
  }
  if (
    !Number.isSafeInteger(candidate.authorizationEpoch) ||
    Number(candidate.authorizationEpoch) < 0
  ) {
    throw new PasskeyFlowError("invalid_action", "authorization epoch is invalid");
  }
  if (!Array.isArray(candidate.scopes) || candidate.scopes.length > MAX_SCOPE_COUNT) {
    throw new PasskeyFlowError("invalid_action", "scopes are invalid");
  }
  const scopes = candidate.scopes.map((scope) => requiredString(scope, "scope", MAX_SCOPE_LENGTH));
  if (new Set(scopes).size !== scopes.length) {
    throw new PasskeyFlowError("invalid_action", "scopes must be unique");
  }
  scopes.sort();
  const workspaceId = optionalString(candidate.workspaceId, "workspaceId");
  const projectId = optionalString(candidate.projectId, "projectId");
  const taskId = optionalString(candidate.taskId, "taskId");
  if ((projectId || taskId) && !workspaceId) {
    throw new PasskeyFlowError("invalid_action", "project and task require a workspace");
  }
  return {
    action,
    clientId: optionalString(candidate.clientId, "clientId"),
    resource: optionalString(candidate.resource, "resource"),
    workspaceId,
    projectId,
    taskId,
    targetId: optionalString(candidate.targetId, "targetId"),
    scopes,
    authorizationEpoch: Number(candidate.authorizationEpoch),
    expiresAt: expiresAt(nowIso),
  };
}

export function parsePresentedStepUpAction(input: unknown): StepUpAction {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PasskeyFlowError("invalid_action", "step-up action is invalid");
  }
  const candidate = input as Record<string, unknown>;
  const presentedExpiry = requiredString(candidate.expiresAt, "expiresAt", 64);
  timestamp(presentedExpiry);
  return {
    ...normalizeStepUpAction(candidate, "2000-01-01T00:00:00.000Z"),
    expiresAt: presentedExpiry,
  };
}

function identityAction(action: string, nowIso: string, targetId?: string): StepUpAction {
  return {
    action,
    targetId,
    scopes: [],
    authorizationEpoch: 0,
    expiresAt: expiresAt(nowIso),
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashesEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(value, "base64url");
  const result = new Uint8Array(new ArrayBuffer(decoded.byteLength));
  result.set(decoded);
  return result;
}

function transports(value: string | null): AuthenticatorTransportFuture[] | undefined {
  return value ? (value.split(",") as AuthenticatorTransportFuture[]) : undefined;
}

function credentialDescriptor(
  id: string,
  value: string | null,
): { id: string; transports?: AuthenticatorTransportFuture[] } {
  const parsed = transports(value);
  return parsed ? { id, transports: parsed } : { id };
}

function storedCredential(passkey: StoredPasskey): WebAuthnCredential {
  const parsed = transports(passkey.transports);
  const credential = {
    id: passkey.credential_id,
    publicKey: base64UrlToBytes(passkey.public_key),
    counter: passkey.counter,
  };
  return parsed ? { ...credential, transports: parsed } : credential;
}

function parseAction(row: CeremonyRow): StepUpAction {
  try {
    const parsed = JSON.parse(row.action_json) as StepUpAction;
    if (!parsed || typeof parsed !== "object" || typeof parsed.action !== "string") {
      throw new Error("invalid action");
    }
    return parsed;
  } catch {
    throw new PasskeyFlowError("invalid_state", "stored passkey action is invalid");
  }
}

async function ceremony(db: SqlDatabase, id: string): Promise<CeremonyRow | undefined> {
  return (await db.prepare(`SELECT * FROM passkey_ceremonies WHERE id = ?`).get(id)) as
    CeremonyRow | undefined;
}

async function assertCeremony(
  db: SqlDatabase,
  id: string,
  principal: BrowserPrincipal,
  nowIso: string,
  expectedKind: CeremonyRow["kind"],
  expectedState: CeremonyRow["state"],
): Promise<CeremonyRow> {
  const row = await ceremony(db, id);
  if (!row) {
    throw new PasskeyFlowError("challenge_invalid", "passkey challenge not found");
  }
  if (
    row.human_id !== principal.humanId ||
    row.auth_user_id !== principal.authUserId ||
    row.session_id !== principal.sessionId
  ) {
    throw new PasskeyFlowError("challenge_mismatch", "passkey challenge principal mismatch");
  }
  if (row.kind !== expectedKind || row.state !== expectedState) {
    throw new PasskeyFlowError("challenge_replayed", "passkey challenge is not active");
  }
  if (timestamp(row.expires_at) <= timestamp(nowIso)) {
    throw new PasskeyFlowError("challenge_expired", "passkey challenge expired");
  }
  return row;
}

async function terminalizeCeremony(
  db: SqlDatabase,
  row: CeremonyRow,
  state: "failed" | "consumed",
  stamp: string,
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE passkey_ceremonies
       SET state = ?, terminal_stamp = ?
       WHERE id = ? AND state = 'challenge_issued' AND terminal_stamp IS NULL`,
    )
    .run(state, stamp, row.id);
  if (result.changes !== 1) {
    throw new PasskeyFlowError("challenge_replayed", "passkey challenge already used");
  }
}

export async function recordPasskeySecurityEvent(
  db: SqlDatabase,
  values: {
    humanId?: string | undefined;
    ceremonyId?: string | undefined;
    kind: "enrollment" | "removal" | "step_up";
    outcome: "succeeded" | "failed";
    code: string;
    now: string;
  },
): Promise<void> {
  const code = requiredString(values.code, "audit code", 64);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(code)) {
    throw new PasskeyFlowError("invalid_audit", "passkey audit code is invalid");
  }
  await db
    .prepare(
      `INSERT INTO passkey_security_events
       (id, human_id, ceremony_id, kind, outcome, code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUlid(),
      values.humanId ?? null,
      values.ceremonyId ?? null,
      values.kind,
      values.outcome,
      code,
      values.now,
    );
}

export async function listPasskeys(
  db: SqlDatabase,
  principal: BrowserPrincipal,
): Promise<Array<{ id: string; name: string | null; createdAt: string | null }>> {
  const rows = (await db
    .prepare(
      `SELECT id, name, created_at
       FROM better_auth_passkeys
       WHERE user_id = ?
       ORDER BY created_at, id`,
    )
    .all(principal.authUserId)) as Array<{
    id: string;
    name: string | null;
    created_at: string | null;
  }>;
  return rows.map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at }));
}

export async function createInitialEnrollmentFlow(
  db: SqlDatabase,
  principal: BrowserPrincipal,
  appOrigin: string,
  nowIso: string,
): Promise<EnrollmentFlow> {
  if ((await listPasskeys(db, principal)).length !== 0) {
    throw new PasskeyFlowError("step_up_required", "existing passkey assertion required");
  }
  const flowId = randomUlid();
  const completion = Buffer.from(randomBytes(32)).toString("base64url");
  const callback = new URL("/auth/passkeys/enroll/reauth", appOrigin);
  callback.searchParams.set("flow_id", flowId);
  callback.searchParams.set("completion", completion);
  const action = identityAction(INITIAL_ENROLLMENT_ACTION, nowIso);
  await db
    .prepare(
      `INSERT INTO passkey_ceremonies
       (id, human_id, auth_user_id, session_id, kind, state, action_json,
        completion_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'registration', 'reauth_pending', ?, ?, ?, ?)`,
    )
    .run(
      flowId,
      principal.humanId,
      principal.authUserId,
      principal.sessionId,
      JSON.stringify(action),
      hash(completion),
      nowIso,
      action.expiresAt,
    );
  return { flowId, callbackUrl: callback.toString(), requiresReauthentication: true };
}

export async function completeInitialEnrollmentReauthentication(
  db: SqlDatabase,
  principal: BrowserPrincipal,
  flowId: string,
  completion: string,
  nowIso: string,
): Promise<void> {
  const row = await ceremony(db, flowId);
  if (
    !row ||
    row.kind !== "registration" ||
    row.state !== "reauth_pending" ||
    row.human_id !== principal.humanId ||
    row.auth_user_id !== principal.authUserId ||
    !row.completion_hash ||
    !hashesEqual(row.completion_hash, hash(completion)) ||
    timestamp(row.expires_at) <= timestamp(nowIso)
  ) {
    throw new PasskeyFlowError("reauthentication_invalid", "fresh GitHub reauthentication failed");
  }
  const result = await db
    .prepare(
      `UPDATE passkey_ceremonies
       SET state = 'ready', session_id = ?, completion_hash = NULL, reauthenticated_at = ?
       WHERE id = ? AND state = 'reauth_pending' AND completion_hash = ?`,
    )
    .run(principal.sessionId, nowIso, flowId, row.completion_hash);
  if (result.changes !== 1) {
    throw new PasskeyFlowError("reauthentication_replayed", "reauthentication already used");
  }
}

export async function createAdditionalEnrollmentFlow(
  db: SqlDatabase,
  principal: BrowserPrincipal,
  proofId: string,
  proofAction: StepUpAction,
  nowIso: string,
): Promise<EnrollmentFlow> {
  if ((await listPasskeys(db, principal)).length === 0) {
    throw new PasskeyFlowError("reauthentication_required", "initial enrollment requires GitHub");
  }
  if (
    proofAction.action !== ADDITIONAL_ENROLLMENT_ACTION ||
    proofAction.targetId ||
    proofAction.workspaceId ||
    proofAction.projectId ||
    proofAction.taskId ||
    proofAction.scopes.length !== 0 ||
    proofAction.authorizationEpoch !== 0
  ) {
    throw new PasskeyFlowError("step_up_mismatch", "step-up action cannot enroll a passkey");
  }
  await consumeStepUpProof(db, proofId, proofAction, nowIso, principal.humanId);
  const flowId = randomUlid();
  const action = identityAction(ADDITIONAL_ENROLLMENT_ACTION, nowIso);
  await db
    .prepare(
      `INSERT INTO passkey_ceremonies
       (id, human_id, auth_user_id, session_id, kind, state, action_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'registration', 'ready', ?, ?, ?)`,
    )
    .run(
      flowId,
      principal.humanId,
      principal.authUserId,
      principal.sessionId,
      JSON.stringify(action),
      nowIso,
      action.expiresAt,
    );
  return { flowId, requiresReauthentication: false };
}

export async function createRegistrationOptions(
  db: SqlDatabase,
  principal: BrowserPrincipal,
  flowId: string,
  appOrigin: string,
  name: string | undefined,
  nowIso: string,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const row = await assertCeremony(db, flowId, principal, nowIso, "registration", "ready");
  const passkeys = (await db
    .prepare(`SELECT credential_id, transports FROM better_auth_passkeys WHERE user_id = ?`)
    .all(principal.authUserId)) as Array<{ credential_id: string; transports: string | null }>;
  const origin = new URL(appOrigin);
  const options = await generateRegistrationOptions({
    rpName: "BFB",
    rpID: origin.hostname,
    userID: Uint8Array.from(new TextEncoder().encode(principal.authUserId)),
    userName: principal.email,
    userDisplayName: principal.displayName,
    attestationType: "none",
    excludeCredentials: passkeys.map((passkey) =>
      credentialDescriptor(passkey.credential_id, passkey.transports),
    ),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
    },
  });
  const result = await db
    .prepare(
      `UPDATE passkey_ceremonies
       SET state = 'challenge_issued', challenge = ?, passkey_name = ?
       WHERE id = ? AND state = 'ready'`,
    )
    .run(options.challenge, name ?? null, row.id);
  if (result.changes !== 1) {
    throw new PasskeyFlowError("challenge_replayed", "registration options already issued");
  }
  return options;
}

export async function verifyRegistration(
  db: SqlDatabase,
  principal: BrowserPrincipal,
  flowId: string,
  response: RegistrationResponseJSON,
  appOrigin: string,
  nowIso: string,
): Promise<{ id: string; name: string | null }> {
  const row = await assertCeremony(
    db,
    flowId,
    principal,
    nowIso,
    "registration",
    "challenge_issued",
  );
  if (!row.challenge) {
    throw new PasskeyFlowError("challenge_invalid", "registration challenge missing");
  }
  try {
    const origin = new URL(appOrigin);
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: row.challenge,
      expectedOrigin: origin.origin,
      expectedRPID: origin.hostname,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw new PasskeyFlowError("verification_failed", "passkey registration failed");
    }
    const { credential, credentialDeviceType, credentialBackedUp, aaguid } =
      verification.registrationInfo;
    const stamp = `${nowIso}#${randomUlid()}`;
    await terminalizeCeremony(db, row, "consumed", stamp);
    const id = randomUlid();
    await db
      .prepare(
        `INSERT INTO better_auth_passkeys
         (id, name, public_key, user_id, credential_id, counter, device_type,
          backed_up, transports, created_at, aaguid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        row.passkey_name,
        bytesToBase64Url(credential.publicKey),
        principal.authUserId,
        credential.id,
        credential.counter,
        credentialDeviceType,
        credentialBackedUp ? 1 : 0,
        response.response.transports?.join(",") ?? null,
        nowIso,
        aaguid,
      );
    await recordPasskeySecurityEvent(db, {
      humanId: principal.humanId,
      ceremonyId: flowId,
      kind: "enrollment",
      outcome: "succeeded",
      code: "passkey_enrolled",
      now: nowIso,
    });
    return { id, name: row.passkey_name };
  } catch (error) {
    if (error instanceof PasskeyFlowError && error.code === "challenge_replayed") {
      throw error;
    }
    try {
      await terminalizeCeremony(db, row, "failed", `${nowIso}#${randomUlid()}`);
    } catch {
      // A concurrent terminal result remains authoritative.
    }
    await recordPasskeySecurityEvent(db, {
      humanId: principal.humanId,
      ceremonyId: flowId,
      kind: "enrollment",
      outcome: "failed",
      code: "registration_failed",
      now: nowIso,
    });
    throw new PasskeyFlowError("verification_failed", "passkey registration failed");
  }
}

export async function createAuthenticationOptions(
  db: SqlDatabase,
  principal: BrowserPrincipal,
  requestedAction: unknown,
  appOrigin: string,
  nowIso: string,
): Promise<{
  challengeId: string;
  action: StepUpAction;
  options: PublicKeyCredentialRequestOptionsJSON;
}> {
  const action = normalizeStepUpAction(requestedAction, nowIso);
  const passkeys = (await db
    .prepare(`SELECT * FROM better_auth_passkeys WHERE user_id = ? ORDER BY id`)
    .all(principal.authUserId)) as StoredPasskey[];
  if (passkeys.length === 0) {
    throw new PasskeyFlowError("passkey_required", "a registered passkey is required");
  }
  const origin = new URL(appOrigin);
  const options = await generateAuthenticationOptions({
    rpID: origin.hostname,
    userVerification: "required",
    allowCredentials: passkeys.map((passkey) =>
      credentialDescriptor(passkey.credential_id, passkey.transports),
    ),
  });
  const challengeId = randomUlid();
  await db
    .prepare(
      `INSERT INTO passkey_ceremonies
       (id, human_id, auth_user_id, session_id, kind, state, action_json,
        challenge, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'authentication', 'challenge_issued', ?, ?, ?, ?)`,
    )
    .run(
      challengeId,
      principal.humanId,
      principal.authUserId,
      principal.sessionId,
      JSON.stringify(action),
      options.challenge,
      nowIso,
      action.expiresAt,
    );
  return { challengeId, action, options };
}

export async function verifyAuthentication(
  db: SqlDatabase,
  principal: BrowserPrincipal,
  challengeId: string,
  response: AuthenticationResponseJSON,
  appOrigin: string,
  nowIso: string,
): Promise<{ proofId: string; action: StepUpAction }> {
  const row = await assertCeremony(
    db,
    challengeId,
    principal,
    nowIso,
    "authentication",
    "challenge_issued",
  );
  if (!row.challenge || typeof response?.id !== "string") {
    throw new PasskeyFlowError("challenge_invalid", "authentication challenge missing");
  }
  const passkey = (await db
    .prepare(`SELECT * FROM better_auth_passkeys WHERE credential_id = ? AND user_id = ?`)
    .get(response.id, principal.authUserId)) as StoredPasskey | undefined;
  if (!passkey) {
    try {
      await terminalizeCeremony(db, row, "failed", `${nowIso}#${randomUlid()}`);
    } catch {
      // A concurrent terminal result remains authoritative.
    }
    await recordPasskeySecurityEvent(db, {
      humanId: principal.humanId,
      ceremonyId: challengeId,
      kind: "step_up",
      outcome: "failed",
      code: "credential_mismatch",
      now: nowIso,
    });
    throw new PasskeyFlowError("credential_mismatch", "passkey does not belong to human");
  }
  try {
    const origin = new URL(appOrigin);
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: row.challenge,
      expectedOrigin: origin.origin,
      expectedRPID: origin.hostname,
      credential: storedCredential(passkey),
      requireUserVerification: true,
    });
    if (!verification.verified) {
      throw new PasskeyFlowError("verification_failed", "passkey assertion failed");
    }
    await terminalizeCeremony(db, row, "consumed", `${nowIso}#${randomUlid()}`);
    const counter = await db
      .prepare(
        `UPDATE better_auth_passkeys
         SET counter = ?
         WHERE id = ? AND counter = ?`,
      )
      .run(verification.authenticationInfo.newCounter, passkey.id, passkey.counter);
    if (counter.changes !== 1) {
      throw new PasskeyFlowError("counter_conflict", "passkey counter changed concurrently");
    }
    const action = parseAction(row);
    const proofId = await issueStepUpProof(db, principal.humanId, action, nowIso);
    await recordPasskeySecurityEvent(db, {
      humanId: principal.humanId,
      ceremonyId: challengeId,
      kind: "step_up",
      outcome: "succeeded",
      code: "step_up_succeeded",
      now: nowIso,
    });
    return { proofId, action };
  } catch (error) {
    if (error instanceof PasskeyFlowError && error.code === "challenge_replayed") {
      throw error;
    }
    try {
      await terminalizeCeremony(db, row, "failed", `${nowIso}#${randomUlid()}`);
    } catch {
      // A concurrent terminal result remains authoritative.
    }
    await recordPasskeySecurityEvent(db, {
      humanId: principal.humanId,
      ceremonyId: challengeId,
      kind: "step_up",
      outcome: "failed",
      code: "assertion_failed",
      now: nowIso,
    });
    throw new PasskeyFlowError("verification_failed", "passkey assertion failed");
  }
}

export async function removePasskey(
  db: SqlDatabase,
  principal: BrowserPrincipal,
  passkeyId: string,
  proofId: string,
  proofAction: StepUpAction,
  nowIso: string,
): Promise<void> {
  if (
    proofAction.action !== REMOVE_PASSKEY_ACTION ||
    proofAction.targetId !== passkeyId ||
    proofAction.workspaceId ||
    proofAction.projectId ||
    proofAction.taskId ||
    proofAction.scopes.length !== 0 ||
    proofAction.authorizationEpoch !== 0
  ) {
    throw new PasskeyFlowError("step_up_mismatch", "step-up action cannot remove this passkey");
  }
  await consumeStepUpProof(db, proofId, proofAction, nowIso, principal.humanId);
  const removed = await db
    .prepare(`DELETE FROM better_auth_passkeys WHERE id = ? AND user_id = ?`)
    .run(passkeyId, principal.authUserId);
  if (removed.changes !== 1) {
    await recordPasskeySecurityEvent(db, {
      humanId: principal.humanId,
      kind: "removal",
      outcome: "failed",
      code: "passkey_not_found",
      now: nowIso,
    });
    throw new PasskeyFlowError("passkey_not_found", "passkey not found");
  }
  await recordPasskeySecurityEvent(db, {
    humanId: principal.humanId,
    kind: "removal",
    outcome: "succeeded",
    code: "passkey_removed",
    now: nowIso,
  });
}

export function additionalEnrollmentAction(nowIso: string): StepUpAction {
  return identityAction(ADDITIONAL_ENROLLMENT_ACTION, nowIso);
}

export function removalAction(credentialId: string, nowIso: string): StepUpAction {
  return identityAction(REMOVE_PASSKEY_ACTION, nowIso, credentialId);
}

export function domainStepUpError(error: unknown): PasskeyFlowError {
  if (error instanceof PasskeyFlowError) {
    return error;
  }
  if (error instanceof DomainError) {
    return new PasskeyFlowError(error.code, error.message);
  }
  return new PasskeyFlowError("request_rejected", "passkey request rejected");
}

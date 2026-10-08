// ABOUTME: Defines canonical P-256 runner keys, challenge transcripts, and stateful token encoding.
// ABOUTME: Secrets are returned to transports only; persistence receives SHA-256 verifiers.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { DomainError } from "./hub.js";
import { isUlid } from "./ids.js";

export const RUNNER_AUDIENCE = "bfb-runner" as const;
export const RUNNER_CHALLENGE_TTL_MS = 60_000;
export const RUNNER_TOKEN_TTL_MS = 5 * 60_000;
export const RUNNER_BODY_LIMIT = 8_192;

export interface RunnerPublicKey {
  crv: "P-256";
  kty: "EC";
  x: string;
  y: string;
}

export interface RunnerRequestBinding {
  method: string;
  path: string;
  body_sha256: string;
}

export interface RunnerChallenge {
  schema_version: 1;
  challenge_id: string;
  server_nonce: string;
  workspace_id: string;
  runner_id: string;
  audience: typeof RUNNER_AUDIENCE;
  origin: string;
  public_key_thumbprint: string;
  purpose: "token" | "request";
  authorization_epoch: number;
  owner_authorization_epoch: number;
  grant_epoch: number;
  token_epoch: number;
  token_id: string | null;
  request: RunnerRequestBinding | null;
  issued_at: string;
  expires_at: string;
}

export interface RunnerTokenClaims {
  v: 1;
  sub: string;
  workspace_id: string;
  aud: typeof RUNNER_AUDIENCE;
  iss: string;
  jti: string;
  iat: number;
  exp: number;
  authorization_epoch: number;
  owner_authorization_epoch: number;
  grant_epoch: number;
  token_epoch: number;
  cnf: { jkt: string };
}

export function rejectRunnerRequest(): never {
  throw new DomainError("request_rejected", "request rejected");
}

export function runnerHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function runnerSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function runnerHashEqual(left: string, right: string): boolean {
  return (
    /^[0-9a-f]{64}$/.test(left) &&
    /^[0-9a-f]{64}$/.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

export function runnerObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    rejectRunnerRequest();
  }
  return value as Record<string, unknown>;
}

export function runnerId(value: unknown): string {
  if (typeof value !== "string" || !isUlid(value)) rejectRunnerRequest();
  return value;
}

export function runnerDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) rejectRunnerRequest();
  return value;
}

function base64Bytes(value: unknown, length: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) rejectRunnerRequest();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== length || bytes.toString("base64url") !== value) rejectRunnerRequest();
  return new Uint8Array(bytes);
}

export async function canonicalRunnerKey(value: unknown): Promise<RunnerPublicKey> {
  const key = runnerObject(value, ["crv", "kty", "x", "y"]);
  if (key.crv !== "P-256" || key.kty !== "EC") rejectRunnerRequest();
  base64Bytes(key.x, 32);
  base64Bytes(key.y, 32);
  const canonical: RunnerPublicKey = {
    crv: "P-256",
    kty: "EC",
    x: key.x as string,
    y: key.y as string,
  };
  try {
    await crypto.subtle.importKey("jwk", canonical, { name: "ECDSA", namedCurve: "P-256" }, false, [
      "verify",
    ]);
  } catch {
    rejectRunnerRequest();
  }
  return canonical;
}

export function runnerKeyThumbprint(key: RunnerPublicKey): string {
  return `sha256:${runnerHash(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y }))}`;
}

export function runnerRequestBinding(
  value: unknown,
  workspaceId: string,
  runner: string,
): RunnerRequestBinding {
  const binding = runnerObject(value, ["method", "path", "body_sha256"]);
  if (
    typeof binding.method !== "string" ||
    !["GET", "POST", "PUT", "DELETE"].includes(binding.method) ||
    typeof binding.path !== "string" ||
    binding.path.length > 512 ||
    !binding.path.startsWith(`/runner/workspaces/${workspaceId}/runners/${runner}/`) ||
    !/^\/[A-Za-z0-9/_-]+$/.test(binding.path)
  )
    rejectRunnerRequest();
  return {
    method: binding.method,
    path: binding.path,
    body_sha256: runnerDigest(binding.body_sha256),
  };
}

/** UTF-8, one fixed-order JSON array, final LF; signatures use IEEE P1363 r||s (64 bytes). */
export function runnerChallengeTranscript(challenge: RunnerChallenge): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `BFB-RUNNER-POSSESSION-V1\n${JSON.stringify([
      challenge.challenge_id,
      challenge.server_nonce,
      challenge.workspace_id,
      challenge.runner_id,
      challenge.audience,
      challenge.origin,
      challenge.public_key_thumbprint,
      challenge.purpose,
      challenge.authorization_epoch,
      challenge.owner_authorization_epoch,
      challenge.grant_epoch,
      challenge.token_epoch,
      challenge.token_id,
      challenge.request === null
        ? null
        : [challenge.request.method, challenge.request.path, challenge.request.body_sha256],
      challenge.issued_at,
      challenge.expires_at,
    ])}\n`,
  );
}

export async function verifyRunnerSignature(
  key: RunnerPublicKey,
  challenge: RunnerChallenge,
  signature: unknown,
): Promise<void> {
  base64Bytes(challenge.server_nonce, 32);
  const bytes = base64Bytes(signature, 64);
  try {
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      key,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    if (
      !(await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        bytes,
        runnerChallengeTranscript(challenge),
      ))
    ) {
      rejectRunnerRequest();
    }
  } catch {
    rejectRunnerRequest();
  }
}

/** Stateful opaque credential, not a JWT. Claims are informational until D1 verification. */
export function encodeRunnerToken(claims: RunnerTokenClaims, secret: string): string {
  base64Bytes(secret, 32);
  return `bfb_runner_${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}.${secret}`;
}

export function decodeRunnerToken(token: unknown): {
  claimsJson: string;
  claims: RunnerTokenClaims;
  secretHash: string;
} {
  if (typeof token !== "string" || token.length > 2048) rejectRunnerRequest();
  const match = /^bfb_runner_([A-Za-z0-9_-]{1,1800})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match?.[1] || !match[2]) rejectRunnerRequest();
  base64Bytes(match[2], 32);
  const raw = Buffer.from(match[1], "base64url");
  if (raw.toString("base64url") !== match[1]) rejectRunnerRequest();
  const claimsJson = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(claimsJson);
  } catch {
    rejectRunnerRequest();
  }
  const claims = runnerObject(parsed, [
    "v",
    "sub",
    "workspace_id",
    "aud",
    "iss",
    "jti",
    "iat",
    "exp",
    "authorization_epoch",
    "owner_authorization_epoch",
    "grant_epoch",
    "token_epoch",
    "cnf",
  ]);
  runnerId(claims.sub);
  runnerId(claims.workspace_id);
  runnerId(claims.jti);
  if (claims.v !== 1 || claims.aud !== RUNNER_AUDIENCE) rejectRunnerRequest();
  return {
    claimsJson,
    claims: claims as unknown as RunnerTokenClaims,
    secretHash: runnerHash(match[2]),
  };
}

// ABOUTME: Owns human CLI device bootstrap, workspace-bound key bindings, and revocation.
// ABOUTME: Only key hashes persist; every request rechecks binding, membership, and epoch.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { SqlDatabase } from "@bfb/db";

import { assertEpoch, assertRole, loadPrincipal, type AuthzPrincipal } from "./authorization.js";
import { DomainError } from "./hub.js";
import type { HubCommand, HubContext } from "./hub.js";
import { isUlid, randomUlid } from "./ids.js";

/** Fixed public client identifier accepted by the device-code issuer. */
export const CLI_CLIENT_ID = "bfb-cli";
/** Public prefix for issued CLI credentials; the remainder is random and hashed. */
export const CLI_KEY_PREFIX = "bfb_cli_";
/** Fixed scopes carried by every CLI binding; callers cannot widen them. */
export const CLI_SCOPES = ["bfb:read", "bfb:task:write"] as const;
/** CLI credential lifetime from exchange (milliseconds). */
export const CLI_KEY_TTL_MS = 30 * 24 * 3_600_000;
/** Bounded request bodies for CLI credential endpoints. */
export const CLI_BODY_LIMIT = 8_192;
/** Named internal issuer: polling the exchange is not authenticated human activity. */
export const CLI_EXCHANGE_ISSUER_ID = "01K00000000000000000000005";

const KEY_SECRET_BYTES = 32;
const KEY_PATTERN = /^bfb_cli_[A-Za-z0-9_-]{43}$/;
const HEX_PATTERN = /^[0-9a-f]{64}$/;

export function rejectCliRequest(): never {
  throw new DomainError("request_rejected", "request rejected");
}

export function cliHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cliHashEqual(left: string, right: string): boolean {
  return (
    HEX_PATTERN.test(left) &&
    HEX_PATTERN.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

export function mintCliKey(): { key: string; keyHash: string; keyPrefix: string } {
  const key = `${CLI_KEY_PREFIX}${randomBytes(KEY_SECRET_BYTES).toString("base64url")}`;
  return { key, keyHash: cliHash(key), keyPrefix: cliKeyPrefix(key) };
}

export function cliKeyPrefix(key: unknown): string {
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) rejectCliRequest();
  return key.slice(0, 12);
}

export function cliObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    rejectCliRequest();
  }
  return value as Record<string, unknown>;
}

function cliUlid(value: unknown): string {
  if (typeof value !== "string" || !isUlid(value)) rejectCliRequest();
  return value;
}

function cliCode(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) rejectCliRequest();
  return value;
}

function projectList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) rejectCliRequest();
  const result = value.map(cliUlid).sort();
  if (new Set(result).size !== result.length) rejectCliRequest();
  return result;
}

export interface CliBindingSummary {
  schema_version: 1;
  binding_id: string;
  workspace_id: string;
  principal_type: "human";
  human_id: string;
  key_prefix: string | null;
  scopes: string[];
  project_ids: string[] | null;
  authorization_epoch: number;
  status: "pending" | "active" | "revoked" | "expired";
  expires_at: string;
  exchanged_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

interface BindingRow {
  workspace_id: string;
  id: string;
  principal_type: string;
  human_id: string | null;
  auth_user_id: string;
  device_row_id: string | null;
  device_code_hash: string;
  key_hash: string | null;
  key_prefix: string | null;
  scopes_json: string;
  project_ids_json: string | null;
  authorization_epoch: number;
  expires_at: string;
  exchanged_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

interface DeviceRow {
  id: string;
  device_code: string;
  user_code: string;
  user_id: string | null;
  expires_at: string;
  status: string;
  client_id: string | null;
}

async function deviceRow(db: SqlDatabase, deviceCode: string): Promise<DeviceRow> {
  const row = (await db
    .prepare(
      `SELECT id, device_code, user_code, user_id, expires_at, status, client_id
       FROM better_auth_device_codes WHERE device_code = ?`,
    )
    .get(deviceCode)) as
    | {
        id: string;
        device_code: string;
        user_code: string;
        user_id: string | null;
        expires_at: string | number | Date;
        status: string;
        client_id: string | null;
      }
    | undefined;
  if (!row) rejectCliRequest();
  return {
    id: String(row.id),
    device_code: String(row.device_code),
    user_code: String(row.user_code),
    user_id: row.user_id === null ? null : String(row.user_id),
    expires_at: new Date(row.expires_at).toISOString(),
    status: String(row.status),
    client_id: row.client_id === null ? null : String(row.client_id),
  };
}

async function bindingRow(
  db: SqlDatabase,
  workspaceId: string,
  bindingId: string,
): Promise<BindingRow> {
  const row = (await db
    .prepare(`SELECT * FROM api_key_bindings WHERE workspace_id = ? AND id = ?`)
    .get(workspaceId, bindingId)) as BindingRow | undefined;
  if (!row) rejectCliRequest();
  return row;
}

async function human(
  ctx: HubContext,
  allowed: Array<"owner" | "member"> = ["owner", "member"],
): Promise<AuthzPrincipal> {
  if (!ctx.actorHumanId || ctx.actorDelegationId || ctx.actorRunnerId || ctx.actorSystemId)
    rejectCliRequest();
  const principal = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
  assertRole(principal, allowed);
  assertEpoch(principal, ctx.authorizationEpoch);
  return principal;
}

async function authUserId(db: SqlDatabase, humanId: string): Promise<string> {
  const row = (await db
    .prepare(`SELECT better_auth_user_id FROM humans WHERE id = ?`)
    .get(humanId)) as { better_auth_user_id: string | null } | undefined;
  if (!row?.better_auth_user_id) rejectCliRequest();
  return row.better_auth_user_id;
}

function summary(row: BindingRow, nowMs: number): CliBindingSummary {
  const scopes = JSON.parse(row.scopes_json) as string[];
  const status: CliBindingSummary["status"] = row.revoked_at
    ? "revoked"
    : row.key_hash === null
      ? "pending"
      : Date.parse(row.expires_at) <= nowMs
        ? "expired"
        : "active";
  return {
    schema_version: 1,
    binding_id: row.id,
    workspace_id: row.workspace_id,
    principal_type: "human",
    human_id: row.human_id ?? "",
    key_prefix: row.key_prefix,
    scopes,
    project_ids: row.project_ids_json ? (JSON.parse(row.project_ids_json) as string[]) : null,
    authorization_epoch: row.authorization_epoch,
    status,
    expires_at: row.expires_at,
    exchanged_at: row.exchanged_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
  };
}

export interface AuthorizeDeviceInput {
  userCode: string;
  projectIds: string[];
}

export const authorizeDeviceCommand: HubCommand<AuthorizeDeviceInput, CliBindingSummary> = {
  name: "cli.authorize_device",
  replay: "reject",
  auditInput: () => ({ action: "cli.authorize_device" }),
  async run(input, ctx) {
    cliObject(input, ["userCode", "projectIds"]);
    const principal = await human(ctx);
    const projects = projectList(input.projectIds);
    if (projects.some((id) => !principal.projectIds.includes(id))) rejectCliRequest();
    const userCode = cliCode(input.userCode, 64);
    const record = (await ctx.db
      .prepare(
        `SELECT id, device_code, user_code, user_id, expires_at, status, client_id
         FROM better_auth_device_codes WHERE user_code = ?`,
      )
      .get(userCode)) as
      | {
          id: string;
          device_code: string;
          user_code: string;
          user_id: string | null;
          expires_at: string | number | Date;
          status: string;
          client_id: string | null;
        }
      | undefined;
    if (!record) rejectCliRequest();
    const recordExpires = Date.parse(new Date(record.expires_at).toISOString());
    if (
      String(record.status) !== "pending" ||
      record.client_id !== CLI_CLIENT_ID ||
      Number.isNaN(recordExpires) ||
      recordExpires <= Date.parse(ctx.now)
    )
      rejectCliRequest();
    if (record.user_id !== (await authUserId(ctx.db, principal.humanId))) rejectCliRequest();
    const existing = (await ctx.db
      .prepare(
        `SELECT id FROM api_key_bindings
         WHERE workspace_id = ? AND device_code_hash = ? AND revoked_at IS NULL`,
      )
      .get(ctx.workspaceId, cliHash(String(record.device_code)))) as
      | { id: string }
      | undefined;
    if (existing) rejectCliRequest();
    const nowMs = Date.parse(ctx.now);
    const created: BindingRow = {
      workspace_id: ctx.workspaceId,
      id: randomUlid(),
      principal_type: "human",
      human_id: principal.humanId,
      auth_user_id: String(record.user_id),
      device_row_id: String(record.id),
      device_code_hash: cliHash(String(record.device_code)),
      key_hash: null,
      key_prefix: null,
      scopes_json: JSON.stringify([...CLI_SCOPES]),
      project_ids_json: projects.length ? JSON.stringify(projects) : null,
      authorization_epoch: principal.authorizationEpoch,
      expires_at: new Date(nowMs + CLI_KEY_TTL_MS).toISOString(),
      exchanged_at: null,
      revoked_at: null,
      created_at: ctx.now,
    };
    await ctx.db
      .prepare(
        `INSERT INTO api_key_bindings
         (workspace_id, id, principal_type, human_id, auth_user_id, device_row_id,
          device_code_hash, key_hash, key_prefix, scopes_json, project_ids_json,
          authorization_epoch, expires_at, exchanged_at, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        created.workspace_id,
        created.id,
        created.principal_type,
        created.human_id,
        created.auth_user_id,
        created.device_row_id,
        created.device_code_hash,
        created.key_hash,
        created.key_prefix,
        created.scopes_json,
        created.project_ids_json,
        created.authorization_epoch,
        created.expires_at,
        created.exchanged_at,
        created.revoked_at,
        created.created_at,
      );
    return summary(created, nowMs);
  },
};

export interface ExchangeCredentialInput {
  deviceCode: string;
  clientId: string;
  keyHash: string;
  keyPrefix: string;
}

export interface ExchangeCredentialResult {
  schema_version: 1;
  binding_id: string;
  workspace_id: string;
  key_prefix: string;
  scopes: string[];
  expires_at: string;
}

export const exchangeCredentialCommand: HubCommand<
  ExchangeCredentialInput,
  ExchangeCredentialResult
> = {
  name: "cli.exchange_credential",
  replay: "reject",
  auditInput: () => ({ action: "cli.exchange_credential" }),
  async run(input, ctx) {
    cliObject(input, ["deviceCode", "clientId", "keyHash", "keyPrefix"]);
    if (ctx.actorHumanId || ctx.actorDelegationId || ctx.actorRunnerId) rejectCliRequest();
    if (input.clientId !== CLI_CLIENT_ID) rejectCliRequest();
    const deviceCode = cliCode(input.deviceCode, 128);
    if (!HEX_PATTERN.test(String(input.keyHash))) rejectCliRequest();
    if (
      typeof input.keyPrefix !== "string" ||
      input.keyPrefix.length !== 12 ||
      !input.keyPrefix.startsWith(CLI_KEY_PREFIX)
    )
      rejectCliRequest();
    const record = await deviceRow(ctx.db, deviceCode);
    if (
      record.status !== "approved" ||
      !record.user_id ||
      record.client_id !== CLI_CLIENT_ID ||
      Date.parse(record.expires_at) <= Date.parse(ctx.now)
    )
      rejectCliRequest();
    const binding = (await ctx.db
      .prepare(
        `SELECT * FROM api_key_bindings
         WHERE workspace_id = ? AND device_code_hash = ? AND revoked_at IS NULL`,
      )
      .get(ctx.workspaceId, cliHash(deviceCode))) as BindingRow | undefined;
    if (
      !binding ||
      binding.principal_type !== "human" ||
      !binding.human_id ||
      binding.auth_user_id !== record.user_id ||
      binding.key_hash !== null ||
      binding.revoked_at !== null ||
      Date.parse(binding.expires_at) <= Date.parse(ctx.now)
    )
      rejectCliRequest();
    const principal = await loadPrincipal(ctx.db, ctx.workspaceId, binding.human_id);
    assertRole(principal, ["owner", "member"]);
    if (principal.authorizationEpoch !== binding.authorization_epoch) rejectCliRequest();
    await ctx.db
      .prepare(
        `UPDATE api_key_bindings SET key_hash = ?, key_prefix = ?, exchanged_at = ?
         WHERE workspace_id = ? AND id = ? AND key_hash IS NULL AND revoked_at IS NULL`,
      )
      .run(input.keyHash, input.keyPrefix, ctx.now, ctx.workspaceId, binding.id);
    const guard = (await ctx.db
      .prepare(`SELECT key_hash FROM api_key_bindings WHERE workspace_id = ? AND id = ?`)
      .get(ctx.workspaceId, binding.id)) as { key_hash: string | null } | undefined;
    if (!guard || !cliHashEqual(guard.key_hash ?? "", String(input.keyHash))) rejectCliRequest();
    await ctx.db
      .prepare(`DELETE FROM better_auth_device_codes WHERE id = ?`)
      .run(record.id);
    return {
      schema_version: 1,
      binding_id: binding.id,
      workspace_id: ctx.workspaceId,
      key_prefix: String(input.keyPrefix),
      scopes: JSON.parse(binding.scopes_json) as string[],
      expires_at: binding.expires_at,
    };
  },
};

export interface RevokeBindingInput {
  bindingId: string;
}

export const revokeBindingCommand: HubCommand<RevokeBindingInput, CliBindingSummary> = {
  name: "cli.revoke_binding",
  replay: "reject",
  auditInput: (input) => ({ bindingId: input.bindingId }),
  async run(input, ctx) {
    cliObject(input, ["bindingId"]);
    const principal = await human(ctx);
    const binding = await bindingRow(ctx.db, ctx.workspaceId, cliUlid(input.bindingId));
    if (binding.principal_type !== "human" || binding.human_id !== principal.humanId)
      rejectCliRequest();
    if (!binding.revoked_at) {
      await ctx.db
        .prepare(
          `UPDATE api_key_bindings SET revoked_at = ?
           WHERE workspace_id = ? AND id = ? AND revoked_at IS NULL`,
        )
        .run(ctx.now, ctx.workspaceId, binding.id);
    }
    if (binding.device_row_id) {
      await ctx.db
        .prepare(`DELETE FROM better_auth_device_codes WHERE id = ?`)
        .run(binding.device_row_id);
    }
    const refreshed = await bindingRow(ctx.db, ctx.workspaceId, binding.id);
    return summary(refreshed, Date.parse(ctx.now));
  },
};

export interface CliPrincipal {
  type: "human";
  humanId: string;
  authUserId: string;
  workspaceId: string;
  bindingId: string;
  keyPrefix: string;
  scopes: string[];
  projectIds: string[];
  authorizationEpoch: number;
  expiresAt: string;
}

/** Resolves a presented CLI credential against its active binding and current membership. */
export async function resolveCliPrincipal(
  db: SqlDatabase,
  bearerToken: unknown,
  now: string,
): Promise<CliPrincipal> {
  if (typeof bearerToken !== "string" || !KEY_PATTERN.test(bearerToken)) {
    throw new DomainError("unauthenticated", "CLI credential required");
  }
  const binding = (await db
    .prepare(
      `SELECT * FROM api_key_bindings WHERE key_hash = ? AND key_hash IS NOT NULL`,
    )
    .get(cliHash(bearerToken))) as BindingRow | undefined;
  if (
    !binding ||
    binding.principal_type !== "human" ||
    !binding.human_id ||
    binding.exchanged_at === null ||
    binding.revoked_at !== null ||
    Date.parse(binding.expires_at) <= Date.parse(now)
  ) {
    throw new DomainError("unauthenticated", "CLI credential is not active");
  }
  let principal: AuthzPrincipal;
  try {
    principal = await loadPrincipal(db, binding.workspace_id, binding.human_id);
  } catch {
    throw new DomainError("unauthenticated", "CLI credential is not active");
  }
  assertRole(principal, ["owner", "member"]);
  if (principal.authorizationEpoch !== binding.authorization_epoch) {
    throw new DomainError("unauthenticated", "CLI credential is not active");
  }
  const bound = binding.project_ids_json
    ? (JSON.parse(binding.project_ids_json) as string[])
    : null;
  const effective = bound ? bound.filter((id) => principal.projectIds.includes(id)) : principal.projectIds;
  if (effective.length === 0) {
    throw new DomainError("forbidden", "CLI credential has no accessible project");
  }
  return {
    type: "human",
    humanId: principal.humanId,
    authUserId: binding.auth_user_id,
    workspaceId: binding.workspace_id,
    bindingId: binding.id,
    keyPrefix: binding.key_prefix ?? "",
    scopes: JSON.parse(binding.scopes_json) as string[],
    projectIds: effective,
    authorizationEpoch: binding.authorization_epoch,
    expiresAt: binding.expires_at,
  };
}

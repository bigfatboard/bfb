// ABOUTME: Shared test helpers that open a migrated async SqlDatabase with synthetic fixtures.
// ABOUTME: Always uses adaptBetterSqlite3 so tests share the Promise-only contract with D1.

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { adaptBetterSqlite3, applyMigrationsForVerification, type SqlDatabase } from "@bfb/db";

import { FIX, seedSyntheticWorkspace } from "../src/fixtures.js";
import { randomUlid } from "../src/ids.js";
import {
  bindProviderAccessToken,
  activateDelegationGrant,
  decideDelegationGrant,
  mcpResource,
  prepareDelegationGrant,
} from "../src/oauth.js";
import { issueStepUpProof } from "../src/step-up.js";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations/d1",
);

export async function openMigratedDomainDb(): Promise<SqlDatabase> {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  applyMigrationsForVerification(raw, migrationsDir);
  return adaptBetterSqlite3(raw);
}

export async function openDomainDb(): Promise<SqlDatabase> {
  const db = await openMigratedDomainDb();
  await seedSyntheticWorkspace(db);
  return db;
}

export async function issueSyntheticMcpAccess(
  db: SqlDatabase,
  input: {
    humanId?: string;
    projectId?: string;
    taskId?: string;
    scopes?: string[];
    now?: string;
    expiresAt?: string;
  } = {},
): Promise<{ accessToken: string; delegationId: string }> {
  const humanId = input.humanId ?? FIX.owner;
  const now = input.now ?? "2026-08-07T12:00:00.000Z";
  const expiresAt = input.expiresAt ?? "2026-08-07T12:10:00.000Z";
  const projectId = input.projectId ?? FIX.projectA;
  const scopes = input.scopes ?? ["bfb:read", "bfb:task:write", "offline_access"];
  const existingHuman = (await db
    .prepare(`SELECT better_auth_user_id FROM humans WHERE id = ?`)
    .get(humanId)) as { better_auth_user_id: string | null } | undefined;
  const authUserId = existingHuman?.better_auth_user_id ?? randomUlid();
  const sessionId = randomUlid();
  const state = `state-${randomUlid()}`;
  const resource = mcpResource("https://bfb.example.test");
  if (!existingHuman?.better_auth_user_id) {
    await db
      .prepare(
        `INSERT INTO better_auth_users
         (id, name, email, email_verified, image, created_at, updated_at)
         SELECT ?, display_name, email, 1, NULL, ?, ? FROM humans WHERE id = ?`,
      )
      .run(authUserId, now, now, humanId);
    await db
      .prepare(`UPDATE humans SET better_auth_user_id = ? WHERE id = ?`)
      .run(authUserId, humanId);
  }
  await db
    .prepare(
      `INSERT INTO better_auth_sessions
       (id, expires_at, token, created_at, updated_at, ip_address, user_agent, user_id)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .run(sessionId, "2027-08-07T12:00:00.000Z", `session-${sessionId}`, now, now, authUserId);
  const authorizationEpoch = 1;
  const action = {
    action: "oauth.delegation.create",
    clientId: FIX.client,
    resource,
    workspaceId: FIX.workspace,
    projectId,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    scopes,
    authorizationEpoch,
    expiresAt,
  };
  const stepUpProofId = await issueStepUpProof(db, humanId, action, now);
  await prepareDelegationGrant(db, {
    humanId,
    authUserId,
    sessionId,
    clientId: FIX.client,
    state,
    resource,
    workspaceId: FIX.workspace,
    projectId,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    scopes,
    authorizationEpoch,
    stepUpProofId,
    providerLabel: "Synthetic Provider",
    now,
  });
  const preparedGrant = (await db
    .prepare(`SELECT id FROM oauth_delegation_grants WHERE state = ?`)
    .get(state)) as { id: string };
  await decideDelegationGrant(db, {
    grantId: preparedGrant.id,
    authUserId,
    sessionId,
    decision: "accepted",
    now,
  });
  await activateDelegationGrant(db, preparedGrant.id, authUserId, scopes, now);

  const accessToken = `mcp_${randomUlid()}${randomUlid()}`;
  const providerTokenId = randomUlid();
  const providerHash = createHash("sha256")
    .update(accessToken.slice("mcp_".length))
    .digest("base64url");
  const grant = (await db
    .prepare(`SELECT id, consumed_at FROM oauth_delegation_grants WHERE state = ?`)
    .get(state)) as { id: string; consumed_at: string };
  await db
    .prepare(
      `INSERT INTO better_auth_oauth_access_tokens
       (id, token, client_id, session_id, user_id, reference_id, refresh_id,
        expires_at, created_at, scopes)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      providerTokenId,
      providerHash,
      FIX.client,
      sessionId,
      authUserId,
      grant.id,
      expiresAt,
      now,
      JSON.stringify(scopes),
    );
  const delegationId = await bindProviderAccessToken(db, accessToken, now);
  if (delegationId !== grant.consumed_at) {
    throw new Error("synthetic delegation binding mismatch");
  }
  return { accessToken, delegationId };
}

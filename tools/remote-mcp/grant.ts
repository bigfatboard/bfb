// ABOUTME: Creates an explicitly synthetic approved OAuth grant for the remote MCP runtime proof.
// ABOUTME: Production delegation functions activate authority; token protocol issuance is a separate browser gate.

import { createHash } from "node:crypto";
import type { SqlDatabase } from "@bfb/db";
import {
  FIX,
  randomUlid,
  issueStepUpProof,
  prepareDelegationGrant,
  decideDelegationGrant,
  activateDelegationGrant,
  bindProviderAccessToken,
} from "@bfb/domain";

export async function syntheticGrant(
  db: SqlDatabase,
  origin: string,
  scopes = ["bfb:read", "bfb:task:write", "offline_access"],
) {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const human = (await db
    .prepare(`SELECT better_auth_user_id FROM humans WHERE id=?`)
    .get(FIX.owner)) as { better_auth_user_id: string | null };
  const authUserId = human.better_auth_user_id ?? randomUlid();
  if (!human.better_auth_user_id) {
    await db
      .prepare(
        `INSERT INTO better_auth_users (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,1,?,?)`,
      )
      .run(authUserId, "Synthetic MCP sponsor", "mcp@synthetic.test", now, now);
    await db
      .prepare(`UPDATE humans SET better_auth_user_id=? WHERE id=?`)
      .run(authUserId, FIX.owner);
  }
  const sessionId = randomUlid();
  await db
    .prepare(
      `INSERT INTO better_auth_sessions (id,expires_at,token,created_at,updated_at,user_id) VALUES (?,?,?,?,?,?)`,
    )
    .run(sessionId, expiresAt, `synthetic-session-${sessionId}`, now, now, authUserId);
  const resource = `${origin}/mcp`;
  const state = `synthetic-${randomUlid()}`;
  const proofId = await issueStepUpProof(
    db,
    FIX.owner,
    {
      action: "oauth.delegation.create",
      clientId: FIX.client,
      resource,
      workspaceId: FIX.workspace,
      projectId: FIX.projectA,
      scopes,
      authorizationEpoch: 1,
      expiresAt,
    },
    now,
  );
  await prepareDelegationGrant(db, {
    humanId: FIX.owner,
    authUserId,
    sessionId,
    clientId: FIX.client,
    state,
    resource,
    workspaceId: FIX.workspace,
    projectId: FIX.projectA,
    scopes,
    authorizationEpoch: 1,
    stepUpProofId: proofId,
    providerLabel: "Synthetic remote client",
    now,
  });
  const grant = (await db
    .prepare(`SELECT id FROM oauth_delegation_grants WHERE state=?`)
    .get(state)) as { id: string };
  await decideDelegationGrant(db, {
    grantId: grant.id,
    authUserId,
    sessionId,
    decision: "accepted",
    now,
  });
  await activateDelegationGrant(db, grant.id, authUserId, scopes, now);
  const accessToken = `mcp_${randomUlid()}${randomUlid()}`;
  const hash = createHash("sha256").update(accessToken.slice(4)).digest("base64url");
  await db
    .prepare(
      `INSERT INTO better_auth_oauth_access_tokens (id,token,client_id,session_id,user_id,reference_id,refresh_id,expires_at,created_at,scopes) VALUES (?,?,?,?,?,?,NULL,?,?,?)`,
    )
    .run(
      randomUlid(),
      hash,
      FIX.client,
      sessionId,
      authUserId,
      grant.id,
      expiresAt,
      now,
      JSON.stringify(scopes),
    );
  const delegationId = await bindProviderAccessToken(db, accessToken, now);
  return { accessToken, delegationId };
}

// ABOUTME: Covers C04 workspace role and project grant boundaries with real loadPrincipal.
// ABOUTME: Reviewers use orthogonal project grants; owners and members see all projects.

import { describe, expect, it } from "vitest";

import {
  assertEpoch,
  assertPasskeyRemovalAllowed,
  loadPrincipal,
  assertProjectAccess,
  assertTaskChildAccess,
  bumpMemberEpoch,
} from "../src/authorization.js";
import { DomainError } from "../src/hub.js";
import { createTaskCommand } from "../src/work-commands.js";
import { WorkspaceHub } from "../src/hub.js";
import { FIX } from "../src/fixtures.js";
import { syntheticUlid } from "../src/ids.js";
import {
  acceptInvitation,
  changeMemberRoleCommand,
  completeWorkspaceBootstrapReauthentication,
  createFirstWorkspace,
  createInvitationCommand,
  removeMemberCommand,
  startWorkspaceBootstrap,
  type WorkspaceIdentity,
} from "../src/workspace-authorization.js";
import { openDomainDb, openMigratedDomainDb } from "./helpers.js";

describe("workspace authorization", () => {
  it("implements owner/member/reviewer with orthogonal project grants", async () => {
    const db = await openDomainDb();
    const owner = await loadPrincipal(db, FIX.workspace, FIX.owner);
    expect(owner.role).toBe("owner");
    expect(owner.projectIds.sort()).toEqual([FIX.projectA, FIX.projectB].sort());
    const member = await loadPrincipal(db, FIX.workspace, FIX.member);
    expect(member.role).toBe("member");
    expect(member.projectIds.sort()).toEqual([FIX.projectA, FIX.projectB].sort());
    const reviewer = await loadPrincipal(db, FIX.workspace, FIX.reviewer);
    expect(reviewer.role).toBe("reviewer");
    expect(reviewer.projectIds).toEqual([FIX.projectA]);
    expect(() => assertProjectAccess(reviewer, FIX.projectB)).toThrow(DomainError);
  });

  it("authorizes task-child reads from the parent task project grant", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const created = await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "authz-task-1",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      now: "2026-08-07T12:00:00Z",
      input: { projectId: FIX.projectB, title: "Beta only", priority: "P2" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const reviewer = await loadPrincipal(db, FIX.workspace, FIX.reviewer);
    await expect(assertTaskChildAccess(db, reviewer, created.result.id)).rejects.toThrow(
      DomainError,
    );
    const owner = await loadPrincipal(db, FIX.workspace, FIX.owner);
    await expect(assertTaskChildAccess(db, owner, created.result.id)).resolves.toBeUndefined();
  });

  it("bumps authorization epoch for revocation", async () => {
    const db = await openDomainDb();
    const next = await bumpMemberEpoch(db, FIX.workspace, FIX.member);
    expect(next).toBe(2);
    const member = await loadPrincipal(db, FIX.workspace, FIX.member);
    expect(member.authorizationEpoch).toBe(2);
  });

  it("creates the first owner only after one fresh reauthentication and one bootstrap secret", async () => {
    const db = await openMigratedDomainDb();
    const humanId = syntheticUlid("BOOTOWNER");
    const authUserId = "auth-user-bootstrap-c04";
    const sessionId = "auth-session-bootstrap-c04";
    const now = "2026-08-11T20:00:00.000Z";
    await db
      .prepare(
        `INSERT INTO better_auth_users
         (id, name, email, email_verified, image, created_at, updated_at)
         VALUES (?, 'Bootstrap Owner', 'bootstrap@synthetic.test', 1, NULL, ?, ?)`,
      )
      .run(authUserId, now, now);
    await db
      .prepare(
        `INSERT INTO better_auth_sessions
         (id, expires_at, token, created_at, updated_at, ip_address, user_agent, user_id)
         VALUES (?, '2027-08-11T20:00:00.000Z', 'bootstrap-token-c04', ?, ?, NULL, NULL, ?)`,
      )
      .run(sessionId, now, now, authUserId);
    await db
      .prepare(
        `INSERT INTO humans (id, better_auth_user_id, email, display_name, created_at)
         VALUES (?, ?, 'bootstrap@synthetic.test', 'Bootstrap Owner', ?)`,
      )
      .run(humanId, authUserId, now);
    await db
      .prepare(
        `INSERT INTO bootstrap_state
         (id, secret_hash, created_at, expires_at, consumed_at, consumption_stamp,
          consumed_by_human_id, workspace_id)
         VALUES ('first_owner', ?, ?, '2026-08-11T21:00:00.000Z', NULL, NULL, NULL, NULL)`,
      )
      .run("a".repeat(64), now);
    const identity: WorkspaceIdentity = {
      humanId,
      authUserId,
      sessionId,
      email: "bootstrap@synthetic.test",
      emailVerified: true,
    };

    await expect(loadPrincipal(db, syntheticUlid("NOWORKSPACE"), humanId)).rejects.toThrow(
      DomainError,
    );
    const flow = await startWorkspaceBootstrap(
      db,
      identity,
      "https://bfb.example.test",
      "b".repeat(64),
      now,
    );
    await completeWorkspaceBootstrapReauthentication(
      db,
      identity,
      flow.flowId,
      "b".repeat(64),
      "2026-08-11T20:01:00.000Z",
    );
    const created = await createFirstWorkspace(
      db,
      identity,
      {
        flowId: flow.flowId,
        bootstrapSecretHash: "a".repeat(64),
        slug: "first-team",
        jurisdiction: "eu",
      },
      "2026-08-11T20:02:00.000Z",
    );
    const owner = await loadPrincipal(db, created.workspaceId, humanId);
    expect(owner).toMatchObject({ role: "owner", authorizationEpoch: 1 });
    await expect(
      createFirstWorkspace(
        db,
        identity,
        {
          flowId: flow.flowId,
          bootstrapSecretHash: "a".repeat(64),
          slug: "second-team",
          jurisdiction: "eu",
        },
        "2026-08-11T20:03:00.000Z",
      ),
    ).rejects.toThrow(DomainError);
    expect(
      await db
        .prepare(`SELECT action FROM audit_events WHERE workspace_id = ?`)
        .all(created.workspaceId),
    ).toEqual([{ action: "workspace.bootstrap" }]);
  });

  it("accepts a hashed invitation once for the exact verified email", async () => {
    const db = await openDomainDb();
    const recipientId = syntheticUlid("INVITEE");
    const invitationId = syntheticUlid("INVITE");
    const now = "2026-08-11T20:00:00.000Z";
    await db
      .prepare(`INSERT INTO humans (id, email, display_name, created_at) VALUES (?, ?, ?, ?)`)
      .run(recipientId, "invitee@synthetic.test", "Synthetic Invitee", now);
    const owner = await loadPrincipal(db, FIX.workspace, FIX.owner);
    const hub = new WorkspaceHub(db);
    const created = await hub.execute(createInvitationCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "c04-invitation-create",
      authorizationEpoch: owner.authorizationEpoch,
      actorHumanId: FIX.owner,
      now,
      input: {
        invitationId,
        normalizedEmail: " Invitee@Synthetic.Test ",
        role: "reviewer",
        secretHash: "c".repeat(64),
        expiresAt: "2026-08-14T20:00:00.000Z",
      },
    });
    expect(created.ok).toBe(true);
    const wrongIdentity: WorkspaceIdentity = {
      humanId: recipientId,
      authUserId: "invitee-auth-c04",
      sessionId: "invitee-session-c04",
      email: "other@synthetic.test",
      emailVerified: true,
    };
    await expect(
      acceptInvitation(
        db,
        { ...wrongIdentity, email: "invitee@synthetic.test", emailVerified: false },
        { workspaceId: FIX.workspace, invitationId, secretHash: "c".repeat(64) },
        "2026-08-11T20:01:00.000Z",
      ),
    ).rejects.toThrow(DomainError);
    await expect(
      acceptInvitation(
        db,
        wrongIdentity,
        { workspaceId: FIX.workspace, invitationId, secretHash: "c".repeat(64) },
        "2026-08-11T20:01:00.000Z",
      ),
    ).rejects.toThrow(DomainError);
    const accepted = await acceptInvitation(
      db,
      { ...wrongIdentity, email: "INVITEE@SYNTHETIC.TEST" },
      { workspaceId: FIX.workspace, invitationId, secretHash: "c".repeat(64) },
      "2026-08-11T20:01:00.000Z",
    );
    expect(accepted).toEqual({
      workspaceId: FIX.workspace,
      role: "reviewer",
      authorizationEpoch: 1,
    });
    await expect(
      acceptInvitation(
        db,
        { ...wrongIdentity, email: "invitee@synthetic.test" },
        { workspaceId: FIX.workspace, invitationId, secretHash: "c".repeat(64) },
        "2026-08-11T20:02:00.000Z",
      ),
    ).rejects.toThrow(DomainError);
    const stored = (await db
      .prepare(`SELECT secret_hash, consumed_at FROM workspace_invitations WHERE id = ?`)
      .get(invitationId)) as { secret_hash: string; consumed_at: string | null };
    expect(stored.secret_hash).toBe("c".repeat(64));
    expect(stored.consumed_at).not.toBeNull();
  });

  it("bumps retained authority and revokes delegations before membership removal", async () => {
    const db = await openDomainDb();
    await db
      .prepare(
        `INSERT INTO oauth_delegations
         (workspace_id, id, human_id, client_id, resource, project_id, task_id,
          scopes_json, authorization_epoch, expires_at, revoked_at, created_at)
         VALUES (?, ?, ?, ?, 'https://bfb.example.test/mcp', NULL, NULL,
                 '["bfb:read"]', 1, '2026-08-12T20:00:00Z', NULL, '2026-08-11T20:00:00Z')`,
      )
      .run(FIX.workspace, syntheticUlid("DELEGATE"), FIX.member, FIX.client);
    const owner = await loadPrincipal(db, FIX.workspace, FIX.owner);
    const outcome = await new WorkspaceHub(db).execute(removeMemberCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "c04-member-remove",
      authorizationEpoch: owner.authorizationEpoch,
      actorHumanId: FIX.owner,
      now: "2026-08-11T20:02:00.000Z",
      input: { humanId: FIX.member },
    });
    expect(outcome).toMatchObject({
      ok: true,
      result: { humanId: FIX.member, revokedAuthorizationEpoch: 2 },
    });
    await expect(loadPrincipal(db, FIX.workspace, FIX.member)).rejects.toThrow(DomainError);
    expect(
      await db
        .prepare(
          `SELECT authorization_epoch, revoked_at FROM workspace_authorization_epochs
           WHERE workspace_id = ? AND human_id = ?`,
        )
        .get(FIX.workspace, FIX.member),
    ).toEqual({ authorization_epoch: 2, revoked_at: "2026-08-11T20:02:00.000Z" });
    expect(
      await db
        .prepare(`SELECT revoked_at FROM oauth_delegations WHERE human_id = ?`)
        .get(FIX.member),
    ).toEqual({ revoked_at: "2026-08-11T20:02:00.000Z" });
  });

  it("lets only owners change ordinary roles and fences the previous epoch", async () => {
    const db = await openDomainDb();
    const owner = await loadPrincipal(db, FIX.workspace, FIX.owner);
    const memberBefore = await loadPrincipal(db, FIX.workspace, FIX.member);
    const changed = await new WorkspaceHub(db).execute(changeMemberRoleCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "c04-role-change",
      authorizationEpoch: owner.authorizationEpoch,
      actorHumanId: FIX.owner,
      now: "2026-08-11T20:00:00.000Z",
      input: { humanId: FIX.member, role: "reviewer" },
    });
    expect(changed).toMatchObject({
      ok: true,
      result: { role: "reviewer", authorizationEpoch: 2 },
    });
    const memberAfter = await loadPrincipal(db, FIX.workspace, FIX.member);
    expect(memberAfter.role).toBe("reviewer");
    expect(() => assertEpoch(memberAfter, memberBefore.authorizationEpoch)).toThrow(DomainError);

    const forbidden = await new WorkspaceHub(db).execute(createInvitationCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "c04-member-invite-forbidden",
      authorizationEpoch: memberAfter.authorizationEpoch,
      actorHumanId: FIX.member,
      now: "2026-08-11T20:01:00.000Z",
      input: {
        invitationId: syntheticUlid("NOINVITE"),
        normalizedEmail: "nope@synthetic.test",
        role: "member",
        secretHash: "d".repeat(64),
        expiresAt: "2026-08-12T20:00:00.000Z",
      },
    });
    expect(forbidden).toMatchObject({ ok: false, error: { code: "forbidden" } });

    const secondOwner = syntheticUlid("OWNER2");
    await db
      .prepare(`INSERT INTO humans (id, email, display_name, created_at) VALUES (?, ?, ?, ?)`)
      .run(secondOwner, "owner2@synthetic.test", "Second Owner", "2026-08-11T20:02:00.000Z");
    await db
      .prepare(
        `INSERT INTO workspace_members
         (workspace_id, human_id, role, authorization_epoch, created_at)
         VALUES (?, ?, 'owner', 1, ?)`,
      )
      .run(FIX.workspace, secondOwner, "2026-08-11T20:02:00.000Z");
    await db
      .prepare(
        `INSERT INTO workspace_authorization_epochs
         (workspace_id, human_id, authorization_epoch, revoked_at, updated_at)
         VALUES (?, ?, 1, NULL, ?)`,
      )
      .run(FIX.workspace, secondOwner, "2026-08-11T20:02:00.000Z");
    const ownerRemoval = await new WorkspaceHub(db).execute(removeMemberCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "c04-owner-removal-requires-step-up",
      authorizationEpoch: owner.authorizationEpoch,
      actorHumanId: FIX.owner,
      now: "2026-08-11T20:03:00.000Z",
      input: { humanId: secondOwner },
    });
    expect(ownerRemoval).toMatchObject({
      ok: false,
      error: { code: "ownership_change_requires_step_up" },
    });
  });

  it("enforces final-owner, final-authenticator, and identity constraints in D1 schema", async () => {
    const db = await openDomainDb();
    const now = "2026-08-11T20:00:00.000Z";
    await db
      .prepare(
        `INSERT INTO better_auth_users
         (id, name, email, email_verified, image, created_at, updated_at)
         VALUES ('owner-auth-c04', 'Synthetic Owner', 'owner-auth@synthetic.test', 1, NULL, ?, ?)`,
      )
      .run(now, now);
    await db
      .prepare(`UPDATE humans SET better_auth_user_id = 'owner-auth-c04' WHERE id = ?`)
      .run(FIX.owner);
    await db
      .prepare(
        `INSERT INTO better_auth_passkeys
         (id, name, public_key, user_id, credential_id, counter, device_type,
          backed_up, transports, created_at, aaguid)
         VALUES ('owner-passkey-c04', 'Owner key', 'AA', 'owner-auth-c04',
                 'owner-credential-c04', 0, 'singleDevice', 0, 'internal', ?, NULL)`,
      )
      .run(now);
    await expect(assertPasskeyRemovalAllowed(db, FIX.owner, "owner-auth-c04")).rejects.toThrow(
      DomainError,
    );
    await expect(
      db.prepare(`DELETE FROM better_auth_passkeys WHERE id = 'owner-passkey-c04'`).run(),
    ).rejects.toThrow(/final passkey/);
    await expect(
      db
        .prepare(
          `INSERT OR REPLACE INTO better_auth_passkeys
           (id, name, public_key, user_id, credential_id, counter, device_type,
            backed_up, transports, created_at, aaguid)
           VALUES ('owner-passkey-c04', 'Replacement key', 'BB', 'owner-auth-c04',
                   'owner-credential-c04', 0, 'singleDevice', 0, 'internal', ?, NULL)`,
        )
        .run(now),
    ).rejects.toThrow(/cannot be replaced/);
    await expect(
      db
        .prepare(
          `UPDATE better_auth_passkeys SET credential_id = 'owner-credential-c04-moved'
           WHERE id = 'owner-passkey-c04'`,
        )
        .run(),
    ).rejects.toThrow(/identity is immutable/);
    await db
      .prepare(
        `INSERT INTO better_auth_passkeys
         (id, name, public_key, user_id, credential_id, counter, device_type,
          backed_up, transports, created_at, aaguid)
         VALUES ('owner-passkey-c04-two', 'Second key', 'CC', 'owner-auth-c04',
                 'owner-credential-c04-two', 0, 'singleDevice', 0, 'internal', ?, NULL)`,
      )
      .run(now);
    await expect(
      assertPasskeyRemovalAllowed(db, FIX.owner, "owner-auth-c04"),
    ).resolves.toBeUndefined();
    await expect(
      db.prepare(`DELETE FROM better_auth_passkeys WHERE id = 'owner-passkey-c04'`).run(),
    ).resolves.toEqual({ changes: 1 });
    await expect(
      db
        .prepare(`DELETE FROM workspace_members WHERE workspace_id = ? AND human_id = ?`)
        .run(FIX.workspace, FIX.owner),
    ).rejects.toThrow(/final workspace owner/);
    await expect(
      db
        .prepare(
          `INSERT OR REPLACE INTO workspace_members
           (workspace_id, human_id, role, authorization_epoch, created_at)
           VALUES (?, ?, 'member', 1, ?)`,
        )
        .run(FIX.workspace, FIX.owner, now),
    ).rejects.toThrow(/cannot be replaced/);
    expect(
      await db
        .prepare(`SELECT role FROM workspace_members WHERE workspace_id = ? AND human_id = ?`)
        .get(FIX.workspace, FIX.owner),
    ).toEqual({ role: "owner" });
    await expect(db.prepare(`DELETE FROM humans WHERE id = ?`).run(FIX.owner)).rejects.toThrow();
  });
});

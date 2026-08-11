// ABOUTME: Exercises mounted bootstrap, invitation, membership, and revocation browser routes.
// ABOUTME: Fresh GitHub auth, exact email, CSRF, one-use secrets, and route authority fail closed.

import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FIX, seedSyntheticWorkspace, syntheticUlid } from "@bfb/domain";

import { parseAuthKeys } from "../src/auth/better-auth.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { createControlApp } from "../src/routes.js";
import {
  AUTH_TEST_ENV,
  openAuthTestContext,
  seedAuthSession,
  type AuthTestContext,
} from "./auth-helpers.js";

const NOW = "2026-08-11T20:00:00.000Z";

function fakeBinding<T extends object>(label: string): T {
  return { __synthetic: label } as unknown as T;
}

function bindings(context?: AuthTestContext): ControlBindings {
  return {
    DB: fakeBinding<D1Database>("db"),
    ARTIFACTS: fakeBinding<R2Bucket>("r2"),
    ASSETS: fakeBinding<Fetcher>("assets"),
    JOBS: fakeBinding<Queue>("jobs"),
    JOBS_DLQ: fakeBinding<Queue>("dlq"),
    WORKSPACE_HUB: context
      ? createTestWorkspaceHubNamespace(context.db)
      : fakeBinding<DurableObjectNamespace>("hub"),
    APP_ORIGIN: AUTH_TEST_ENV.APP_ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  };
}

function appFor(context: AuthTestContext) {
  return createControlApp(validateControlEnv(bindings()), {
    db: context.db,
    now: NOW,
    humanAuth: () => ({
      auth: context.auth,
      keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    }),
  });
}

function responseCookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .filter((value): value is string => Boolean(value))
    .join("; ");
}

function mergeCookies(...headers: string[]): string {
  const cookies = new Map<string, string>();
  for (const header of headers) {
    for (const item of header.split(/;\s*/)) {
      const separator = item.indexOf("=");
      if (separator > 0) {
        cookies.set(item.slice(0, separator), item.slice(separator + 1));
      }
    }
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

function capabilityHash(value: string): string {
  return createHmac("sha256", AUTH_TEST_ENV.AUTH_ABUSE_SECRET)
    .update(`bfb-workspace-capability:${value}`)
    .digest("hex");
}

async function csrfFor(
  app: ReturnType<typeof appFor>,
  cookie: string,
  currentBindings: ControlBindings,
): Promise<string> {
  const response = await app.request(
    new Request(`${AUTH_TEST_ENV.APP_ORIGIN}/auth/session`, { headers: { cookie } }),
    undefined,
    currentBindings,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { csrf_token: string }).csrf_token;
}

function mutation(
  path: string,
  method: "POST" | "DELETE",
  cookie: string,
  csrf: string,
  body: unknown,
  ip = "192.0.2.120",
): Request {
  return new Request(AUTH_TEST_ENV.APP_ORIGIN + path, {
    method,
    headers: {
      cookie,
      "content-type": "application/json",
      origin: AUTH_TEST_ENV.APP_ORIGIN,
      "sec-fetch-site": "same-origin",
      "x-bfb-csrf": csrf,
      "cf-connecting-ip": ip,
    },
    body: JSON.stringify(body),
  });
}

function mockGitHub(email: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const request = input instanceof Request ? input : new Request(input);
      if (request.url === "https://github.com/login/oauth/access_token") {
        return Response.json({
          access_token: "github-bootstrap-access-token",
          token_type: "bearer",
          scope: "read:user,user:email",
        });
      }
      if (request.url === "https://api.github.com/user") {
        return Response.json({
          id: 4343,
          login: "bootstrap-c04",
          name: "Bootstrap Owner",
          email: null,
          avatar_url: "https://avatars.example.test/c04.png",
        });
      }
      if (request.url === "https://api.github.com/user/emails") {
        return Response.json([{ email, primary: true, verified: true }]);
      }
      throw new Error(`unexpected provider request: ${request.url}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workspace authorization routes", () => {
  it("bootstraps the first owner only after a fresh GitHub round trip", async () => {
    const context = openAuthTestContext();
    const session = await seedAuthSession(context, {
      userId: "bootstrap-user-c04",
      sessionId: "bootstrap-session-c04",
      token: "bootstrap-token-c04",
      email: "bootstrap@synthetic.test",
      name: "Bootstrap Owner",
    });
    context.raw
      .prepare(
        `INSERT INTO better_auth_accounts
         (id, account_id, provider_id, user_id, access_token, refresh_token, id_token,
          access_token_expires_at, refresh_token_expires_at, scope, password, created_at, updated_at)
         VALUES ('bootstrap-account-c04', '4343', 'github', ?, NULL, NULL, NULL,
                 NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(session.userId, NOW, NOW);
    const rawBootstrapSecret = "bootstrap-secret-c04-not-stored";
    context.raw
      .prepare(
        `INSERT INTO bootstrap_state
         (id, secret_hash, created_at, expires_at, consumed_at, consumption_stamp,
          consumed_by_human_id, workspace_id)
         VALUES ('first_owner', ?, ?, '2026-08-11T21:00:00.000Z', NULL, NULL, NULL, NULL)`,
      )
      .run(capabilityHash(rawBootstrapSecret), NOW);
    const app = appFor(context);
    const currentBindings = bindings(context);
    const csrf = await csrfFor(app, session.cookie, currentBindings);

    const started = await app.request(
      mutation("/api/v1/workspace-access/bootstrap/start", "POST", session.cookie, csrf, {}),
      undefined,
      currentBindings,
    );
    expect(started.status, await started.clone().text()).toBe(200);
    const startBody = (await started.clone().json()) as { flow_id: string; url: string };
    expect(startBody.url).not.toContain("workspace_bootstrap");
    const direct = await app.request(
      new Request(
        `${AUTH_TEST_ENV.APP_ORIGIN}/api/v1/workspace-access/bootstrap/reauth?flow_id=${startBody.flow_id}`,
        { headers: { cookie: session.cookie, "cf-connecting-ip": "192.0.2.121" } },
      ),
      undefined,
      currentBindings,
    );
    expect(direct.status).toBe(403);

    const authorize = new URL(startBody.url);
    const state = authorize.searchParams.get("state");
    expect(state).toBeTruthy();
    mockGitHub("bootstrap@synthetic.test");
    const callback = new URL(`${AUTH_TEST_ENV.APP_ORIGIN}/auth/callback/github`);
    callback.searchParams.set("code", "fresh-github-code-c04");
    callback.searchParams.set("state", state!);
    const callbackResponse = await app.request(
      new Request(callback, {
        headers: {
          cookie: mergeCookies(session.cookie, responseCookies(started)),
          "cf-connecting-ip": "192.0.2.122",
        },
      }),
      undefined,
      currentBindings,
    );
    expect(callbackResponse.status).toBe(302);
    const completionLocation = callbackResponse.headers.get("location");
    expect(completionLocation).toBe(
      `${AUTH_TEST_ENV.APP_ORIGIN}/api/v1/workspace-access/bootstrap/reauth?flow_id=${startBody.flow_id}`,
    );
    const freshCookie = mergeCookies(
      session.cookie,
      responseCookies(started),
      responseCookies(callbackResponse),
    );
    const completedReauth = await app.request(
      new Request(completionLocation!, {
        headers: { cookie: freshCookie, "cf-connecting-ip": "192.0.2.122" },
      }),
      undefined,
      currentBindings,
    );
    expect(completedReauth.status).toBe(302);

    const freshCsrf = await csrfFor(app, freshCookie, currentBindings);
    const completed = await app.request(
      mutation(
        "/api/v1/workspace-access/bootstrap/complete",
        "POST",
        freshCookie,
        freshCsrf,
        {
          flow_id: startBody.flow_id,
          bootstrap_secret: rawBootstrapSecret,
          slug: "c04-team",
        },
        "192.0.2.123",
      ),
      undefined,
      currentBindings,
    );
    expect(completed.status, await completed.clone().text()).toBe(200);
    const result = (await completed.json()) as { workspaceId: string; role: string };
    expect(result.role).toBe("owner");
    expect(
      context.raw
        .prepare(`SELECT role FROM workspace_members WHERE workspace_id = ?`)
        .get(result.workspaceId),
    ).toEqual({ role: "owner" });
    expect(
      JSON.stringify(context.raw.prepare(`SELECT * FROM bootstrap_state`).get()),
    ).not.toContain(rawBootstrapSecret);

    const replay = await app.request(
      mutation(
        "/api/v1/workspace-access/bootstrap/complete",
        "POST",
        freshCookie,
        freshCsrf,
        {
          flow_id: startBody.flow_id,
          bootstrap_secret: rawBootstrapSecret,
          slug: "c04-team-two",
        },
        "192.0.2.124",
      ),
      undefined,
      currentBindings,
    );
    expect(replay.status).toBe(403);
  });

  it("creates and accepts a copyable invitation once, then revokes the member", async () => {
    const context = openAuthTestContext();
    await seedSyntheticWorkspace(context.db, NOW);
    const ownerSession = await seedAuthSession(context, {
      userId: "owner-user-c04",
      sessionId: "owner-session-c04",
      token: "owner-token-c04",
      email: "owner@synthetic.test",
      name: "Synthetic Owner",
      humanId: FIX.owner,
    });
    const recipientSession = await seedAuthSession(context, {
      userId: "recipient-user-c04",
      sessionId: "recipient-session-c04",
      token: "recipient-token-c04",
      email: "recipient@synthetic.test",
      name: "Synthetic Recipient",
    });
    const app = appFor(context);
    const currentBindings = bindings(context);
    const ownerCsrf = await csrfFor(app, ownerSession.cookie, currentBindings);
    const create = await app.request(
      mutation(
        `/api/v1/workspace-access/workspaces/${FIX.workspace}/invitations`,
        "POST",
        ownerSession.cookie,
        ownerCsrf,
        {
          request_id: "c04-route-invitation-create",
          email: " Recipient@Synthetic.Test ",
          role: "member",
          workspace_id: syntheticUlid("IGNOREDWS"),
        },
      ),
      undefined,
      currentBindings,
    );
    expect(create.status, await create.clone().text()).toBe(200);
    const created = (await create.json()) as {
      invitation: { id: string; normalizedEmail: string; role: string };
      invitation_url: string;
    };
    expect(created.invitation).toMatchObject({
      normalizedEmail: "recipient@synthetic.test",
      role: "member",
    });
    const invitationUrl = new URL(created.invitation_url);
    const rawSecret = invitationUrl.hash.slice(1);
    expect(rawSecret.length).toBeGreaterThan(30);
    const stored = context.raw
      .prepare(`SELECT workspace_id, secret_hash FROM workspace_invitations WHERE id = ?`)
      .get(created.invitation.id) as { workspace_id: string; secret_hash: string };
    expect(stored.workspace_id).toBe(FIX.workspace);
    expect(stored.secret_hash).not.toContain(rawSecret);
    const invitationEvent = context.raw
      .prepare(
        `SELECT payload_json FROM semantic_events
         WHERE workspace_id = ? AND kind = 'workspace.invitation.create'`,
      )
      .get(FIX.workspace) as { payload_json: string };
    expect(invitationEvent.payload_json).not.toContain(rawSecret);

    const pending = await app.request(
      mutation(
        `/api/v1/workspace-access/workspaces/${FIX.workspace}/invitations`,
        "POST",
        ownerSession.cookie,
        ownerCsrf,
        {
          request_id: "c04-route-invitation-pending-before-membership",
          email: "recipient@synthetic.test",
          role: "member",
        },
        "192.0.2.124",
      ),
      undefined,
      currentBindings,
    );
    expect(pending.status, await pending.clone().text()).toBe(200);
    const pendingBody = (await pending.json()) as {
      invitation: { id: string };
      invitation_url: string;
    };
    const pendingSecret = new URL(pendingBody.invitation_url).hash.slice(1);

    const recipientCsrf = await csrfFor(app, recipientSession.cookie, currentBindings);
    const accepted = await app.request(
      mutation(
        `/api/v1/workspace-access/workspaces/${FIX.workspace}/invitations/${created.invitation.id}/accept`,
        "POST",
        recipientSession.cookie,
        recipientCsrf,
        { secret: rawSecret },
        "192.0.2.125",
      ),
      undefined,
      currentBindings,
    );
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    const recipient = context.raw
      .prepare(`SELECT id FROM humans WHERE email = 'recipient@synthetic.test'`)
      .get() as { id: string };
    expect(
      context.raw
        .prepare(
          `SELECT role, authorization_epoch FROM workspace_members
           WHERE workspace_id = ? AND human_id = ?`,
        )
        .get(FIX.workspace, recipient.id),
    ).toEqual({ role: "member", authorization_epoch: 1 });

    const replay = await app.request(
      mutation(
        `/api/v1/workspace-access/workspaces/${FIX.workspace}/invitations/${created.invitation.id}/accept`,
        "POST",
        recipientSession.cookie,
        recipientCsrf,
        { secret: rawSecret },
        "192.0.2.126",
      ),
      undefined,
      currentBindings,
    );
    expect(replay.status).toBe(403);

    const roleChange = await app.request(
      mutation(
        `/api/v1/workspace-access/workspaces/${FIX.workspace}/members/${recipient.id}/role`,
        "POST",
        ownerSession.cookie,
        ownerCsrf,
        { request_id: "c04-route-role-change", role: "reviewer" },
        "192.0.2.127",
      ),
      undefined,
      currentBindings,
    );
    expect(roleChange.status, await roleChange.clone().text()).toBe(200);
    expect(
      context.raw
        .prepare(
          `SELECT role, authorization_epoch FROM workspace_members
           WHERE workspace_id = ? AND human_id = ?`,
        )
        .get(FIX.workspace, recipient.id),
    ).toEqual({ role: "reviewer", authorization_epoch: 2 });

    const removed = await app.request(
      mutation(
        `/api/v1/workspace-access/workspaces/${FIX.workspace}/members/${recipient.id}`,
        "DELETE",
        ownerSession.cookie,
        ownerCsrf,
        { request_id: "c04-route-member-remove" },
        "192.0.2.128",
      ),
      undefined,
      currentBindings,
    );
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(
      context.raw
        .prepare(
          `SELECT authorization_epoch, revoked_at FROM workspace_authorization_epochs
           WHERE workspace_id = ? AND human_id = ?`,
        )
        .get(FIX.workspace, recipient.id),
    ).toEqual({ authorization_epoch: 3, revoked_at: NOW });
    const staleAcceptance = await app.request(
      mutation(
        `/api/v1/workspace-access/workspaces/${FIX.workspace}/invitations/${pendingBody.invitation.id}/accept`,
        "POST",
        recipientSession.cookie,
        recipientCsrf,
        { secret: pendingSecret },
        "192.0.2.129",
      ),
      undefined,
      currentBindings,
    );
    expect(staleAcceptance.status).toBe(403);
    expect(
      context.raw
        .prepare(`SELECT revoked_at FROM workspace_invitations WHERE id = ?`)
        .get(pendingBody.invitation.id),
    ).toEqual({ revoked_at: NOW });

    const reissued = await app.request(
      mutation(
        `/api/v1/workspace-access/workspaces/${FIX.workspace}/invitations`,
        "POST",
        ownerSession.cookie,
        ownerCsrf,
        {
          request_id: "c04-route-invitation-reissue",
          email: "recipient@synthetic.test",
          role: "reviewer",
        },
        "192.0.2.130",
      ),
      undefined,
      currentBindings,
    );
    expect(reissued.status, await reissued.clone().text()).toBe(200);
    const reissuedBody = (await reissued.json()) as {
      invitation: { id: string };
      invitation_url: string;
    };
    const reissuedSecret = new URL(reissuedBody.invitation_url).hash.slice(1);
    const reaccepted = await app.request(
      mutation(
        `/api/v1/workspace-access/workspaces/${FIX.workspace}/invitations/${reissuedBody.invitation.id}/accept`,
        "POST",
        recipientSession.cookie,
        recipientCsrf,
        { secret: reissuedSecret },
        "192.0.2.131",
      ),
      undefined,
      currentBindings,
    );
    expect(reaccepted.status, await reaccepted.clone().text()).toBe(200);
    expect(
      context.raw
        .prepare(
          `SELECT membership.role, membership.authorization_epoch, epoch.revoked_at
           FROM workspace_members AS membership
           JOIN workspace_authorization_epochs AS epoch
             ON epoch.workspace_id = membership.workspace_id
            AND epoch.human_id = membership.human_id
           WHERE membership.workspace_id = ? AND membership.human_id = ?`,
        )
        .get(FIX.workspace, recipient.id),
    ).toEqual({ role: "reviewer", authorization_epoch: 4, revoked_at: null });
    const duplicateMemberInvite = await app.request(
      mutation(
        `/api/v1/workspace-access/workspaces/${FIX.workspace}/invitations`,
        "POST",
        ownerSession.cookie,
        ownerCsrf,
        {
          request_id: "c04-route-active-member-invitation",
          email: "recipient@synthetic.test",
          role: "member",
        },
        "192.0.2.132",
      ),
      undefined,
      currentBindings,
    );
    expect(duplicateMemberInvite.status).toBe(403);

    const finalOwner = await app.request(
      mutation(
        `/api/v1/workspace-access/workspaces/${FIX.workspace}/members/${FIX.owner}`,
        "DELETE",
        ownerSession.cookie,
        ownerCsrf,
        { request_id: "c04-route-final-owner-remove" },
        "192.0.2.133",
      ),
      undefined,
      currentBindings,
    );
    expect(finalOwner.status).toBe(403);

    const otherWorkspace = syntheticUlid("OTHERWS");
    context.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version)
         VALUES (?, 'other-c04', 'eu', ?, 1)`,
      )
      .run(otherWorkspace, NOW);
    const crossWorkspace = await app.request(
      mutation(
        `/api/v1/workspace-access/workspaces/${otherWorkspace}/invitations`,
        "POST",
        ownerSession.cookie,
        ownerCsrf,
        {
          request_id: "c04-cross-workspace-invite",
          email: "cross@synthetic.test",
          role: "member",
        },
        "192.0.2.134",
      ),
      undefined,
      currentBindings,
    );
    expect(crossWorkspace.status).toBe(403);
  });

  it("rejects cookie-only, cross-origin, cross-workspace, and organization shortcuts", async () => {
    const context = openAuthTestContext();
    await seedSyntheticWorkspace(context.db, NOW);
    const memberSession = await seedAuthSession(context, {
      userId: "member-user-c04",
      sessionId: "member-session-c04",
      token: "member-token-c04",
      email: "member@synthetic.test",
      name: "Synthetic Member",
      humanId: FIX.member,
    });
    const app = appFor(context);
    const currentBindings = bindings(context);
    const memberCsrf = await csrfFor(app, memberSession.cookie, currentBindings);
    const forbidden = await app.request(
      mutation(
        `/api/v1/workspace-access/workspaces/${FIX.workspace}/invitations`,
        "POST",
        memberSession.cookie,
        memberCsrf,
        {
          request_id: "c04-member-cannot-invite",
          email: "forbidden@synthetic.test",
          role: "member",
        },
      ),
      undefined,
      currentBindings,
    );
    expect(forbidden.status).toBe(403);

    const cookieOnly = await app.request(
      new Request(
        `${AUTH_TEST_ENV.APP_ORIGIN}/api/v1/workspace-access/workspaces/${FIX.workspace}/invitations`,
        {
          method: "POST",
          headers: { cookie: memberSession.cookie, "content-type": "application/json" },
          body: JSON.stringify({
            request_id: "c04-cookie-only-rejected",
            email: "forbidden@synthetic.test",
          }),
        },
      ),
      undefined,
      currentBindings,
    );
    expect(cookieOnly.status).toBe(403);

    const bearerRequest = mutation(
      `/api/v1/workspace-access/workspaces/${FIX.workspace}/invitations`,
      "POST",
      memberSession.cookie,
      memberCsrf,
      {
        request_id: "c04-bearer-confusion-rejected",
        email: "forbidden@synthetic.test",
        role: "member",
      },
    );
    bearerRequest.headers.set("authorization", "Bearer bfb_cli_wrong-surface");
    const bearer = await app.request(bearerRequest, undefined, currentBindings);
    expect(bearer.status).toBe(401);

    const oversized = await app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}/api/v1/workspace-access/bootstrap/complete`, {
        method: "POST",
        headers: {
          cookie: memberSession.cookie,
          "content-type": "application/json",
          origin: AUTH_TEST_ENV.APP_ORIGIN,
          "sec-fetch-site": "same-origin",
        },
        body: "x".repeat(16_385),
      }),
      undefined,
      currentBindings,
    );
    expect(oversized.status).toBe(429);

    const organization = await app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}/auth/organization/create`, {
        method: "POST",
        headers: {
          cookie: memberSession.cookie,
          origin: AUTH_TEST_ENV.APP_ORIGIN,
          "sec-fetch-site": "same-origin",
          "x-bfb-csrf": memberCsrf,
        },
      }),
      undefined,
      currentBindings,
    );
    expect(organization.status).toBe(404);
  });
});

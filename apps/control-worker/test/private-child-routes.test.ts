// ABOUTME: Proves private run, execution, session, snapshot, result and attention HTTP delivery stays task-scoped.
// ABOUTME: Real synthetic browser sessions exercise deny/grant/revoke and revocation between parent and child reads.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIX, randomUlid, requestAttentionCommand, submitResultCommand } from "@bfb/domain";
import { captureFixture } from "../../../packages/domain/test/agent-capture-fixture.js";
import { LAUNCH_NOW, success } from "../../../packages/domain/test/launch-fixture.js";
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

const BASE = `/api/v1/workspaces/${FIX.workspace}`;
const CANARY = "SYNTHETIC-C11-PRIVATE-HTTP-CHILD";
const contexts: AuthTestContext[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(LAUNCH_NOW));
});
afterEach(() => {
  for (const context of contexts.splice(0)) context.raw.close();
  vi.useRealTimers();
});

async function fixture() {
  const context = openAuthTestContext(LAUNCH_NOW);
  contexts.push(context);
  const f = await captureFixture(context.db, false, false, {
    taskCreatorHumanId: FIX.member,
    requestingHumanId: FIX.owner,
  });
  const attention = success(
    await f.native(requestAttentionCommand, {
      principal: f.principal,
      request: { ...f.bound(), kind: "clarification", question: CANARY, blocking: true },
    }),
  );
  success(await f.human(submitResultCommand, { runId: f.launch.run_id, summary: CANARY }));
  await f.db
    .prepare(
      `INSERT INTO task_privacy
    (workspace_id, task_id, owner_human_id, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(FIX.workspace, f.task.id, FIX.member, LAUNCH_NOW);
  const actors = {} as Record<"owner" | "member", { cookie: string; csrf: string }>;
  const fake = <T extends object>(label: string) => ({ __synthetic: label }) as unknown as T;
  const bindings: ControlBindings = {
    DB: fake<D1Database>("db"),
    ARTIFACTS: fake<R2Bucket>("r2"),
    ASSETS: fake<Fetcher>("assets"),
    JOBS: fake<Queue>("jobs"),
    JOBS_DLQ: fake<Queue>("dlq"),
    WORKSPACE_HUB: createTestWorkspaceHubNamespace(f.db),
    APP_ORIGIN: AUTH_TEST_ENV.APP_ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  };
  const app = createControlApp(validateControlEnv(bindings), {
    db: f.db,
    now: LAUNCH_NOW,
    humanAuth: () => ({
      auth: context.auth,
      keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    }),
  });
  for (const [actor, humanId] of [
    ["owner", FIX.owner],
    ["member", FIX.member],
  ] as const) {
    const session = await seedAuthSession(context, {
      userId: `private-child-${actor}-user`,
      sessionId: `private-child-${actor}-session`,
      token: `private-child-${actor}-token`,
      email: `${actor}@synthetic.test`,
      name: `Synthetic ${actor}`,
      humanId,
      now: LAUNCH_NOW,
    });
    const response = await app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}/auth/session`, {
        headers: { cookie: session.cookie },
      }),
      undefined,
      bindings,
    );
    expect(response.status).toBe(200);
    actors[actor] = {
      cookie: session.cookie,
      csrf: ((await response.json()) as { csrf_token: string }).csrf_token,
    };
  }
  async function request(
    path: string,
    actor: "owner" | "member" = "owner",
    value?: Record<string, unknown>,
  ) {
    return app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${path}`, {
        method: value ? "POST" : "GET",
        headers: {
          cookie: actors[actor].cookie,
          ...(value
            ? {
                "content-type": "application/json",
                origin: AUTH_TEST_ENV.APP_ORIGIN,
                "sec-fetch-site": "same-origin",
                "x-bfb-csrf": actors[actor].csrf,
              }
            : {}),
        },
        ...(value ? { body: JSON.stringify(value) } : {}),
      }),
      undefined,
      bindings,
    );
  }
  async function grant(permission: "read" | "contribute" = "read") {
    const id = randomUlid();
    await f.db
      .prepare(
        `INSERT INTO task_human_grants
      (workspace_id, id, task_id, human_id, authorization_epoch, permission, created_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(FIX.workspace, id, f.task.id, FIX.owner, permission, LAUNCH_NOW);
    return id;
  }
  async function revoke(id: string) {
    await f.db
      .prepare("UPDATE task_human_grants SET revoked_at = ? WHERE id = ?")
      .run(LAUNCH_NOW, id);
  }
  return { ...f, attention, request, grant, revoke };
}

describe("private child browser delivery", () => {
  it.each(["", "/snapshot", "/executions?limit=1", "/sessions?limit=1", "/results"])(
    "run%s is missing-equivalent for an unshared owner and revoked grant",
    async (suffix) => {
      const f = await fixture();
      const path = `${BASE}/runs/${f.launch.run_id}${suffix}`;
      const denied = await f.request(path);
      const missing = await f.request(`${BASE}/runs/00000000000000000000000000${suffix}`);
      expect(denied.status).toBe(404);
      expect(await denied.json()).toEqual(await missing.json());
      expect((await f.request(path, "member")).status).toBe(200);
      const id = await f.grant();
      const current = await f.request(path);
      expect(current.status).toBe(200);
      const content = await current.text();
      if (suffix === "/results") expect(content).toContain(CANARY);
      await f.revoke(id);
      const revoked = await f.request(path);
      expect(revoked.status).toBe(404);
      expect(await revoked.text()).not.toContain(CANARY);
    },
  );

  it("attention HTTP read/answer requires read/contribute separately, including cached answer replay", async () => {
    const f = await fixture();
    const path = `${BASE}/attention/${f.attention.id}`;
    expect((await f.request(path)).status).toBe(404);
    expect(await (await f.request(`${BASE}/attention?limit=1`)).json()).toMatchObject({
      attention: [],
    });
    const readId = await f.grant();
    expect(await (await f.request(path)).text()).toContain(CANARY);
    const input = { request_id: "synthetic-private-answer", expected_version: 1, answer: CANARY };
    expect((await f.request(`${path}/answer`, "owner", input)).status).toBe(404);
    await f.revoke(readId);
    const contributeId = await f.grant("contribute");
    expect((await f.request(`${path}/answer`, "owner", input)).status).toBe(200);
    expect((await f.request(`${path}/answer`, "owner", input)).status).toBe(200);
    await f.revoke(contributeId);
    const cached = await f.request(`${path}/answer`, "owner", input);
    expect(cached.status).toBe(404);
    expect(await cached.text()).not.toContain(CANARY);
  });

  it.each(["executions", "sessions", "snapshot"])(
    "%s delivery rechecks a revoke after parent selection",
    async (child) => {
      const f = await fixture();
      const id = await f.grant();
      const original = f.db.prepare.bind(f.db);
      let revoked = false;
      const pattern =
        child === "executions"
          ? /FROM run_executions AS execution/
          : child === "sessions"
            ? /FROM provider_sessions AS session/
            : /FROM run_configuration_snapshots AS snapshot/;
      vi.spyOn(f.db, "prepare").mockImplementation((query: string) => {
        const statement = original(query);
        if (!pattern.test(query)) return statement;
        const revokeOnce = async () => {
          if (!revoked) {
            revoked = true;
            await original("UPDATE task_human_grants SET revoked_at = ? WHERE id = ?").run(
              LAUNCH_NOW,
              id,
            );
          }
        };
        return {
          ...statement,
          all: async (...params: unknown[]) => {
            await revokeOnce();
            return statement.all(...params);
          },
          get: async (...params: unknown[]) => {
            await revokeOnce();
            return statement.get(...params);
          },
        };
      });
      const response = await f.request(`${BASE}/runs/${f.launch.run_id}/${child}`);
      expect(revoked).toBe(true);
      if (child === "snapshot") expect(response.status).toBe(404);
      else expect(await response.json()).toMatchObject({ [child]: [], has_more: false });
    },
  );
});

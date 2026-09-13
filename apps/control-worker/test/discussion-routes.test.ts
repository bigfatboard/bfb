// ABOUTME: Exercises discussion creation, history and human decisions through authenticated browser routes.
// ABOUTME: Rejects credential substitution, malformed original bytes and caller-selected participant authority.

import { afterEach, describe, expect, it } from "vitest";
import { FIX, randomUlid } from "@bfb/domain";
import type { DiscussionReceipt } from "@bfb/protocol";

import {
  discussionFixture,
  HUMAN_ONLY_CANARY,
} from "../../../packages/domain/test/discussion-fixture.js";
import { LAUNCH_NOW } from "../../../packages/domain/test/launch-fixture.js";
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

const contexts: AuthTestContext[] = [];
afterEach(() => {
  for (const context of contexts.splice(0)) context.raw.close();
});

async function setup() {
  const context = openAuthTestContext(LAUNCH_NOW);
  contexts.push(context);
  const f = await discussionFixture(context.db);
  const sessions = [];
  for (const [role, humanId] of [
    ["owner", FIX.owner],
    ["reviewer", FIX.reviewer],
  ] as const)
    sessions.push(
      await seedAuthSession(context, {
        userId: `synthetic-discussion-${role}-user`,
        sessionId: `synthetic-discussion-${role}-session`,
        token: `synthetic-discussion-${role}-token`,
        email: `${role}@synthetic-discussion.test`,
        humanId,
      }),
    );
  const fake = <T extends object>() => ({ __synthetic: "discussion-api" }) as unknown as T;
  const bindings: ControlBindings = {
    DB: fake<D1Database>(),
    ARTIFACTS: fake<R2Bucket>(),
    ASSETS: fake<Fetcher>(),
    JOBS: fake<Queue>(),
    JOBS_DLQ: fake<Queue>(),
    WORKSPACE_HUB: createTestWorkspaceHubNamespace(context.db),
    APP_ORIGIN: AUTH_TEST_ENV.APP_ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  };
  const app = createControlApp(validateControlEnv(bindings), {
    db: context.db,
    now: LAUNCH_NOW,
    humanAuth: () => ({
      auth: context.auth,
      keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    }),
  });
  const request = (path: string, init: RequestInit = {}) =>
    app.request(new Request(`${AUTH_TEST_ENV.APP_ORIGIN}${path}`, init), undefined, bindings);
  const credentials = [];
  for (const session of sessions) {
    const response = await request("/auth/session", { headers: { cookie: session.cookie } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { csrf_token: string };
    credentials.push({ cookie: session.cookie, "x-bfb-csrf": body.csrf_token });
  }
  const owner = credentials[0]!,
    reviewer = credentials[1]!;
  const post = (path: string, value: unknown, auth = owner, headers: Record<string, string> = {}) =>
    request(path, {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        origin: AUTH_TEST_ENV.APP_ORIGIN,
        "sec-fetch-site": "same-origin",
        ...headers,
      },
      body: JSON.stringify(value),
    });
  const get = (path: string, auth = owner) => request(path, { headers: { cookie: auth.cookie } });
  const base = `/api/v1/workspaces/${FIX.workspace}`,
    collection = `${base}/tasks/${f.task.id}/discussions`;
  const created = async () => {
    const response = await post(collection, f.input);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { result: DiscussionReceipt }).result;
  };
  return { f, context, request, post, get, owner, reviewer, base, collection, created };
}

describe("D01 authenticated discussion API", () => {
  it("creates and replays one discussion, reads frozen human history and leaves normal work untouched", async () => {
    const s = await setup(),
      first = await s.created(),
      second = await s.created();
    expect(second).toEqual(first);
    const path = `${s.base}/discussions/${first.discussion_id}`;
    const history = await s.get(path);
    expect(history.status).toBe(200);
    expect(history.headers.get("cache-control")).toBe("no-store");
    const text = await history.text();
    expect(text).not.toContain(HUMAN_ONLY_CANARY);
    expect(JSON.parse(text)).toMatchObject({
      discussion: { scope: "human", state: "active", version: 1 },
    });
    const list = await s.get(`${s.collection}?limit=1`);
    expect(await list.json()).toMatchObject({
      discussions: [{ id: first.discussion_id }],
      has_more: false,
    });
    const runs = await s.get(`${s.base}/tasks/${s.f.task.id}/runs`);
    expect(await runs.json()).toMatchObject({ runs: [] });
    for (const run of first.run_ids!) {
      expect((await s.get(`${s.base}/runs/${run}`)).status).toBe(404);
      expect((await s.get(`${s.base}/runs/${run}/snapshot`)).status).toBe(404);
      expect(
        (await s.post(`${s.base}/runs/${run}/executions`, { request_id: randomUlid() })).status,
      ).toBe(404);
    }
    const task = await s.get(`${s.base}/tasks/${s.f.task.id}`);
    expect(await task.json()).toMatchObject({ task: { state: "ready", resource_version: 1 } });
  });

  it("requires browser authentication, same-origin CSRF and writable human project scope", async () => {
    const s = await setup();
    expect((await s.request(s.collection)).status).toBe(401);
    expect(
      (
        await s.request(s.collection, {
          headers: { authorization: "Bearer synthetic-discussion-run-token" },
        })
      ).status,
    ).toBe(401);
    expect(
      (await s.post(s.collection, s.f.input, { cookie: s.owner.cookie, "x-bfb-csrf": "" })).status,
    ).toBe(403);
    expect(
      (
        await s.post(s.collection, s.f.input, s.owner, {
          origin: "https://synthetic-attacker.test",
        })
      ).status,
    ).toBe(403);
    expect((await s.post(s.collection, s.f.input, s.reviewer)).status).toBe(403);
    expect(await s.f.db.prepare("SELECT COUNT(*) AS count FROM discussions").get()).toEqual({
      count: 0,
    });
  });

  it("rejects malformed original bytes, oversized bodies and forged participant or task binding", async () => {
    const s = await setup();
    const wire = JSON.stringify(s.f.input);
    const malformed: BodyInit[] = [
      wire.replace('"schema_version":1', '"schema_version":1,"schema_version":1'),
      wire.replace('"question":', '"question":NaN,"unexpected":'),
      new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d]),
      wire.slice(0, -1),
      `${wire} {}`,
    ];
    for (const body of malformed) {
      const response = await s.request(s.collection, {
        method: "POST",
        headers: {
          ...s.owner,
          origin: AUTH_TEST_ENV.APP_ORIGIN,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body,
      });
      expect(response.status, await response.clone().text()).toBe(400);
    }
    expect(
      (await s.post(s.collection, s.f.input, s.owner, { "content-length": "65537" })).status,
    ).toBe(413);
    expect(
      (await s.post(s.collection, { ...s.f.input, question: "界".repeat(30_000) })).status,
    ).toBe(413);
    for (const extra of [
      { participant_run_id: randomUlid() },
      { scope: "participant" },
      { task_id: randomUlid() },
    ])
      expect((await s.post(s.collection, { ...s.f.input, ...extra })).status).toBe(400);
    expect(await s.f.db.prepare("SELECT COUNT(*) AS count FROM discussions").get()).toEqual({
      count: 0,
    });
  });

  it("hides inaccessible and cross-workspace history and exposes no participant mutation surface", async () => {
    const s = await setup(),
      result = await s.created(),
      path = `${s.base}/discussions/${result.discussion_id}`;
    expect((await s.get(path, s.reviewer)).status).toBe(200);
    await s.f.db
      .prepare(
        "DELETE FROM project_access WHERE workspace_id = ? AND project_id = ? AND human_id = ?",
      )
      .run(FIX.workspace, FIX.projectA, FIX.reviewer);
    expect((await s.get(path, s.reviewer)).status).toBe(404);
    expect((await s.get(s.collection, s.reviewer)).status).toBe(404);
    expect((await s.get(path.replace(FIX.workspace, randomUlid()))).status).toBe(403);
    for (const suffix of ["?scope=participant", `?run_id=${result.run_ids![0]}`])
      expect((await s.get(`${path}${suffix}`)).status).toBe(400);
    for (const suffix of ["/turns", "/participants", "/messages"])
      expect((await s.post(`${path}${suffix}`, { run_id: result.run_ids![0] })).status).toBe(404);
    expect(
      (
        await s.post(path, {
          schema_version: 1,
          idempotency_key: randomUlid(),
          discussion_id: result.discussion_id,
          expected_version: 1,
          action: "dispatch",
          run_id: result.run_ids![0],
        })
      ).status,
    ).toBe(400);
    for (const suffix of ["?limit=0", "?limit=51", "?cursor=bad", "?scope=participant"])
      expect((await s.get(`${s.collection}${suffix}`)).status).toBe(400);
  });

  it("records intervention, cancellation and a separate immutable human decision without work acceptance", async () => {
    const s = await setup(),
      result = await s.created(),
      path = `${s.base}/discussions/${result.discussion_id}`;
    const change = (version: number, action: string, extra: object = {}) => ({
      schema_version: 1,
      idempotency_key: randomUlid(),
      discussion_id: result.discussion_id,
      expected_version: version,
      action,
      ...extra,
    });
    const intervention = change(1, "intervene", { text: "Synthetic human clarification" });
    expect((await s.post(path, intervention)).status).toBe(200);
    expect((await s.post(path, intervention)).status).toBe(200);
    expect((await s.post(path, change(1, "cancel"))).status).toBe(409);
    expect((await s.post(path, change(2, "cancel"))).status).toBe(200);
    const decision = change(3, "decide", {
      decision: {
        kind: "needs_more_context",
        summary: "Synthetic unresolved question",
        recommendation_ids: [],
      },
    });
    expect((await s.post(path, decision, s.reviewer)).status).toBe(403);
    const decided = await s.post(path, decision);
    expect(decided.status, await decided.clone().text()).toBe(200);
    expect((await s.post(path, decision)).status).toBe(200);
    expect(
      (await s.post(path, { ...decision, idempotency_key: randomUlid(), expected_version: 4 }))
        .status,
    ).toBe(409);
    const history = await s.get(path);
    expect(await history.json()).toMatchObject({
      discussion: {
        state: "cancelled",
        messages: [{ kind: "intervention" }],
        decision: { human_id: FIX.owner, kind: "needs_more_context" },
      },
    });
    expect(
      await s.f.db
        .prepare("SELECT state, resource_version FROM tasks WHERE id = ?")
        .get(s.f.task.id),
    ).toEqual({ state: "ready", resource_version: 1 });
    const audit = await s.f.db
      .prepare("SELECT payload_json FROM semantic_events WHERE kind LIKE 'discussion.%'")
      .all();
    expect(JSON.stringify(audit)).not.toContain("Synthetic human clarification");
    expect(JSON.stringify(audit)).not.toContain("Synthetic unresolved question");
  });
});

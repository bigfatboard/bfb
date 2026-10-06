// ABOUTME: Proves private notification suppression through real queue contacts and mounted human/runner delivery.
// ABOUTME: Synthetic sessions and request-bound runner signatures exercise endpoint, token and parent races.

import type { SqlDatabase } from "@bfb/db";
import {
  FIX,
  answerAttentionCommand,
  deriveDeliveryId,
  fanoutNotificationEvent,
  notificationJobId,
  randomUlid,
  registerPushEndpointCommand,
  requestAttentionCommand,
  runnerChallengeTranscript,
  runnerHash,
  type RunnerChallenge,
} from "@bfb/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFixture } from "../../../packages/domain/test/agent-capture-fixture.js";
import { LAUNCH_NOW, success } from "../../../packages/domain/test/launch-fixture.js";
import { parseAuthKeys } from "../src/auth/better-auth.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { dispatchNotificationOutbox } from "../src/notifications/dispatch.js";
import { handleNotifyMessage } from "../src/notifications/queue.js";
import { base64UrlEncode, type VapidSecrets } from "../src/notifications/push.js";
import { createControlApp } from "../src/routes.js";
import {
  AUTH_TEST_ENV,
  openAuthTestContext,
  seedAuthSession,
  type AuthTestContext,
} from "./auth-helpers.js";

const ORIGIN = AUTH_TEST_ENV.APP_ORIGIN,
  BASE = `/api/v1/workspaces/${FIX.workspace}`;
const contexts: AuthTestContext[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(LAUNCH_NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
  contexts.splice(0).forEach((context) => context.raw.close());
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
      request: {
        ...f.bound(),
        kind: "clarification",
        question: "SYNTHETIC_PRIVATE_PUSH_QUESTION",
        blocking: true,
      },
    }),
  );
  const { workspace_cursor: cursor } = (await f.db
    .prepare(
      "SELECT workspace_cursor FROM semantic_events WHERE kind = 'attention.request' ORDER BY workspace_cursor DESC LIMIT 1",
    )
    .get()) as { workspace_cursor: number };
  const receiver = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const p256dh = base64UrlEncode(
    new Uint8Array((await crypto.subtle.exportKey("raw", receiver.publicKey)) as ArrayBuffer),
  );
  const auth = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
  for (const name of ["a", "b"])
    success(
      await f.human(registerPushEndpointCommand, {
        endpoint: `https://push.synthetic.test/${name}`,
        p256dh,
        auth,
      }),
    );
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const vapid: VapidSecrets = {
    publicKey: base64UrlEncode(
      new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer),
    ),
    privateKey: jwk.d!,
    subject: "mailto:synthetic@bfb.test",
  };
  const bindings = {
    DB: {},
    ARTIFACTS: {},
    ASSETS: {},
    JOBS: {},
    JOBS_DLQ: {},
    WORKSPACE_HUB: createTestWorkspaceHubNamespace(f.db),
    APP_ORIGIN: ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  } as unknown as ControlBindings;
  const app = (db = f.db) =>
    createControlApp(validateControlEnv(bindings), {
      db,
      now: LAUNCH_NOW,
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      humanAuth: () => ({
        auth: context.auth,
        keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
        abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      }),
    });
  const cookies = {} as Record<"owner" | "member", string>;
  for (const [actor, humanId] of [
    ["owner", FIX.owner],
    ["member", FIX.member],
  ] as const) {
    cookies[actor] = (
      await seedAuthSession(context, {
        userId: `private-notify-${actor}-user`,
        sessionId: `private-notify-${actor}-session`,
        token: `private-notify-${actor}-token`,
        humanId,
        email: `${actor}@synthetic.test`,
        now: LAUNCH_NOW,
      })
    ).cookie;
  }
  const privacy = () =>
    f.db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, f.task.id, FIX.member, LAUNCH_NOW);
  const input = {
    workspaceId: FIX.workspace,
    eventCursor: cursor,
    eventKind: "attention.request",
    now: LAUNCH_NOW,
  };
  const message = {
    body: {
      schema_version: 1 as const,
      job_id: notificationJobId(FIX.workspace, cursor),
      workspace_id: FIX.workspace,
      event_cursor: cursor,
      event_kind: "attention.request",
    },
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
  const queue = (fetchImpl: typeof fetch, attempts = 1, database = f.db) =>
    handleNotifyMessage(
      { ...message, attempts },
      { db: database, sendDlq: async () => {}, appOrigin: ORIGIN, vapid },
      LAUNCH_NOW,
      fetchImpl,
    );
  const browser = (actor: keyof typeof cookies = "owner", db = f.db) =>
    app(db).request(
      new Request(`${ORIGIN}${BASE}/notifications/deliveries?limit=1`, {
        headers: { cookie: cookies[actor] },
      }),
      undefined,
      bindings,
    );
  const nativePrefix = `/runner/workspaces/${FIX.workspace}/runners/${f.runner}`;
  async function native(action: "pull" | "ack", body: unknown, db = f.db) {
    const bytes = JSON.stringify(body),
      path = `${nativePrefix}/notifications/${action}`;
    const challengeResponse = await app().request(
      new Request(`${ORIGIN}${nativePrefix}/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          purpose: "request",
          token: f.token,
          request: { method: "POST", path, body_sha256: runnerHash(bytes) },
        }),
      }),
      undefined,
      bindings,
    );
    expect(challengeResponse.status, await challengeResponse.clone().text()).toBe(200);
    const challenge = ((await challengeResponse.json()) as { challenge: RunnerChallenge })
      .challenge;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      f.key.privateKey,
      runnerChallengeTranscript(challenge),
    );
    const proof = Buffer.from(
      JSON.stringify({
        challenge_id: challenge.challenge_id,
        server_nonce: challenge.server_nonce,
        signature: Buffer.from(signature).toString("base64url"),
        token: f.token,
      }),
    ).toString("base64url");
    return app(db).request(
      new Request(ORIGIN + path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bfb-runner-proof": proof },
        body: bytes,
      }),
      undefined,
      bindings,
    );
  }
  const macosId = deriveDeliveryId(FIX.workspace, cursor, "macos", f.runner);
  return { ...f, attention, cursor, input, message, queue, privacy, browser, native, macosId };
}
function before(db: SqlDatabase, match: RegExp, change: () => Promise<void>): SqlDatabase {
  let fired = false;
  return {
    ...db,
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!match.test(sql)) return statement;
      const invoke = async () => {
        if (!fired) {
          fired = true;
          await change();
        }
      };
      return {
        ...statement,
        async get(...params) {
          await invoke();
          return statement.get(...params);
        },
        async all(...params) {
          await invoke();
          return statement.all(...params);
        },
        async run(...params) {
          await invoke();
          return statement.run(...params);
        },
      };
    },
  };
}

describe("private notification Worker boundaries", () => {
  it("honors opt-out after signing and before the final endpoint SELECT despite enabled preflight", async () => {
    const f = await fixture(),
      original = crypto.subtle.sign.bind(crypto.subtle);
    let signed = false,
      changed = false;
    vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
      const signature = await original(...args);
      signed = true;
      return signature;
    });
    const db: SqlDatabase = {
      ...f.db,
      prepare(sql) {
        const statement = f.db.prepare(sql);
        if (
          !signed ||
          !/SELECT endpoint_hash, endpoint, p256dh, auth FROM notification_push_endpoints/.test(sql)
        )
          return statement;
        return {
          ...statement,
          async all(...parameters) {
            if (!changed) {
              changed = true;
              await f.db
                .prepare(
                  `INSERT INTO notification_preferences
            (workspace_id,human_id,project_id,channel,category,enabled,updated_at)
            VALUES (?,?,?,'browser_push','attention',0,?)`,
                )
                .run(FIX.workspace, FIX.owner, FIX.projectA, LAUNCH_NOW);
            }
            return statement.all(...parameters);
          },
        };
      },
    };
    const contact = vi.fn(async () => new Response(null, { status: 201 }));
    await f.queue(contact as typeof fetch, 1, db);
    expect(signed).toBe(true);
    expect(changed).toBe(true);
    expect(contact).not.toHaveBeenCalled();
  });
  it("advances internal dispatch past denied private attention without queueing it", async () => {
    const f = await fixture();
    await f.privacy();
    const sent: unknown[] = [];
    await dispatchNotificationOutbox(
      f.db,
      async (message) => {
        sent.push(message);
      },
      LAUNCH_NOW,
    );
    expect(sent).toEqual([]);
    expect(
      (
        (await f.db
          .prepare("SELECT last_cursor FROM notification_dispatch_state WHERE workspace_id = ?")
          .get(FIX.workspace)) as { last_cursor: number }
      ).last_cursor,
    ).toBeGreaterThanOrEqual(f.cursor);
  });
  it("contacts no endpoint or recipient row for an initially private task", async () => {
    const f = await fixture();
    await f.privacy();
    const contact = vi.fn(async () => new Response(null, { status: 201 }));
    await f.queue(contact as typeof fetch);
    expect(contact).not.toHaveBeenCalled();
    expect(f.message.ack).toHaveBeenCalledOnce();
    expect(await f.db.prepare("SELECT delivery_id FROM notification_deliveries").all()).toEqual([]);
  });
  it.each(["private", "epoch", "project"])(
    "rechecks %s authority between expired endpoint and its sibling",
    async (condition) => {
      const f = await fixture();
      const contact = vi.fn(async () => {
        if (condition === "private") await f.privacy();
        else if (condition === "epoch") {
          await f.db
            .prepare(
              "UPDATE workspace_authorization_epochs SET authorization_epoch = 2 WHERE human_id = ?",
            )
            .run(FIX.owner);
          await f.db
            .prepare("UPDATE workspace_members SET authorization_epoch = 2 WHERE human_id = ?")
            .run(FIX.owner);
        } else {
          await f.db
            .prepare("UPDATE projects SET access_mode = 'restricted' WHERE id = ?")
            .run(FIX.projectA);
          await f.db
            .prepare("DELETE FROM project_access WHERE project_id = ? AND human_id = ?")
            .run(FIX.projectA, FIX.owner);
        }
        return new Response(null, { status: 410 });
      });
      await f.queue(contact as typeof fetch);
      expect(contact).toHaveBeenCalledOnce();
      expect(f.message.retry).not.toHaveBeenCalled();
    },
  );
  it("rechecks parent after encryption and VAPID signing immediately before external fetch", async () => {
    const f = await fixture();
    const original = crypto.subtle.sign.bind(crypto.subtle);
    let changed = false;
    vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
      const signature = await original(...args);
      if (!changed) {
        changed = true;
        await f.privacy();
      }
      return signature;
    });
    const contact = vi.fn(async () => new Response(null, { status: 201 }));
    await f.queue(contact as typeof fetch);
    expect(changed).toBe(true);
    expect(contact).not.toHaveBeenCalled();
  });
  it("rechecks retry rather than replaying the earlier shared push authority", async () => {
    const f = await fixture();
    const contact = vi.fn(async () => new Response(null, { status: 503 }));
    await f.queue(contact as typeof fetch);
    expect(contact).toHaveBeenCalledTimes(2);
    expect(f.message.retry).toHaveBeenCalledOnce();
    await f.privacy();
    await f.queue(contact as typeof fetch, 2);
    expect(contact).toHaveBeenCalledTimes(2);
  });
  it("preserves answered shared mounted history then suppresses private history for creator and owner", async () => {
    const f = await fixture();
    await fanoutNotificationEvent(f.db, f.input);
    success(
      await f.human(answerAttentionCommand, {
        attentionId: f.attention.id,
        expectedVersion: 1,
        answer: "Synthetic retained answer",
      }),
    );
    const shared = await f.browser();
    expect(shared.status).toBe(200);
    expect(((await shared.json()) as { deliveries: unknown[] }).deliveries).toHaveLength(1);
    const native = await f.native("pull", {});
    expect(native.status).toBe(200);
    expect(await native.json()).toMatchObject({ deliveries: [{ delivery_id: f.macosId }] });
    await f.privacy();
    for (const actor of ["owner", "member"] as const) {
      const response = await f.browser(actor);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ deliveries: [] });
    }
    const hidden = await f.native("pull", {});
    expect(hidden.status).toBe(200);
    expect(await hidden.json()).toMatchObject({ deliveries: [] });
    const ack = await f.native("ack", { delivery_ids: [f.macosId] }),
      absent = await f.native("ack", { delivery_ids: [randomUlid()] });
    expect(ack.status).toBe(200);
    expect(await ack.json()).toEqual(await absent.json());
    expect(
      await f.db
        .prepare("SELECT acked_at FROM notification_macos_inbox WHERE delivery_id = ?")
        .get(f.macosId),
    ).toEqual({ acked_at: null });
  });
  it("fences runner revocation after mounted proof resolution at actual inbox selection", async () => {
    const f = await fixture();
    await fanoutNotificationEvent(f.db, f.input);
    const db = before(f.db, /FROM notification_macos_inbox AS inbox/, async () => {
      await f.db
        .prepare("UPDATE runner_tokens SET revoked_at = ? WHERE id = ?")
        .run(LAUNCH_NOW, f.principal.tokenId);
    });
    const response = await f.native("pull", {}, db);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ deliveries: [] });
  });
});

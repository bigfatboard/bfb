// ABOUTME: Proves W02 browser reads and idempotent launch/control behavior.
// ABOUTME: Typed states, grant boundaries, and no-absolute-path guarantees included.

import { describe, expect, it } from "vitest";
import {
  authorizeLaunchCommand,
  claimLaunchCommand,
  createTaskCommand,
  FIX,
  observeCheckoutLeaseCommand,
  randomUlid,
  type LaunchClaim,
} from "@bfb/domain";
import type { CheckoutLeaseObservation, LaunchStartRequest } from "@bfb/protocol";

import {
  LAUNCH_NOW,
  launchFixture,
  success,
} from "../../../packages/domain/test/launch-fixture.js";
import { parseAuthKeys } from "../src/auth/better-auth.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { createControlApp } from "../src/routes.js";
import { AUTH_TEST_ENV, openAuthTestContext, seedAuthSession } from "./auth-helpers.js";

const ORIGIN = AUTH_TEST_ENV.APP_ORIGIN;

async function fixture() {
  const context = openAuthTestContext(LAUNCH_NOW),
    f = await launchFixture(context.db);
  async function session(humanId: string, email: string, suffix: string) {
    const seeded = await seedAuthSession(context, {
      userId: `auth-user-w02-${suffix}`,
      sessionId: `auth-session-w02-${suffix}`,
      token: `auth-token-w02-${suffix}`,
      email,
      name: `W02 ${suffix}`,
      humanId,
    });
    const authed = await app().request(
      new Request(`${ORIGIN}/auth/session`, { headers: { cookie: seeded.cookie } }),
      undefined,
      env,
    );
    expect(authed.status).toBe(200);
    const csrf = ((await authed.json()) as { csrf_token: string }).csrf_token;
    return { cookie: seeded.cookie, csrf };
  }
  const env = {
    DB: {},
    ARTIFACTS: {},
    ASSETS: {},
    JOBS: {},
    JOBS_DLQ: {},
    WORKSPACE_HUB: createTestWorkspaceHubNamespace(context.db),
    APP_ORIGIN: ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  } as unknown as ControlBindings;
  function app() {
    return createControlApp(validateControlEnv(env), {
      db: context.db,
      now: LAUNCH_NOW,
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      humanAuth: () => ({
        auth: context.auth,
        keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
        abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      }),
    });
  }
  const owner = await session(FIX.owner, "owner@synthetic.test", "owner");
  const member = await session(FIX.member, "member@synthetic.test", "member");
  const restricted = await session(FIX.restricted, "restricted@synthetic.test", "restricted");
  async function request(
    identity: { cookie: string; csrf: string },
    method: string,
    action: string,
    body?: unknown,
    raw?: string,
  ) {
    return app().request(
      new Request(`${ORIGIN}/api/v1/workspaces/${FIX.workspace}/${action}`, {
        method,
        headers: {
          cookie: identity.cookie,
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
          "x-bfb-csrf": identity.csrf,
          "content-type": "application/json",
        },
        body: body === undefined && raw === undefined ? undefined : (raw ?? JSON.stringify(body)),
      }),
      undefined,
      env,
    );
  }
  return { ...f, context, env, app, owner, member, restricted, request };
}

function stringsOf(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringsOf);
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(stringsOf);
  }
  return [];
}

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(keysOf);
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => [key, ...keysOf(child)]);
  }
  return [];
}

describe("w02 launch operations browser surface", () => {
  it("serves sanitized checkout status without absolute paths", async () => {
    const f = await fixture();
    const response = await f.request(f.owner, "GET", `runners/${f.runner}/checkouts`);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as {
      runner_id: string;
      device_label: string;
      inventory_received_at: string;
      inventory_valid: boolean;
      checkouts: Record<string, unknown>[];
      providers: { provider: string; capabilities: string[] }[];
    };
    expect(body.runner_id).toBe(f.runner);
    expect(body.inventory_valid).toBe(true);
    expect(body.checkouts).toHaveLength(1);
    expect(body.checkouts[0]).toMatchObject({
      checkout_id: f.checkout,
      label: "Synthetic checkout",
      dirty: false,
      status: "validated",
    });
    expect(body.providers[0]).toMatchObject({ provider: "fake" });
    expect(body.providers[0]!.capabilities).toContain("launch.interactive");
    for (const text of stringsOf(body)) {
      expect(text.startsWith("/"), `absolute path leaked: ${text}`).toBe(false);
    }
    for (const key of keysOf(body.checkouts)) {
      expect(
        key.toLowerCase().includes("path") && key !== "workspace_subpath",
        `path-bearing key: ${key}`,
      ).toBe(false);
    }
  });

  it("refuses checkout reads for humans without a launcher grant", async () => {
    const f = await fixture();
    for (const identity of [f.member, f.restricted]) {
      const response = await f.request(identity, "GET", `runners/${f.runner}/checkouts`);
      expect(response.status).toBe(403);
    }
    const unknown = await f.request(f.owner, "GET", `runners/${randomUlid()}/checkouts`);
    expect(unknown.status).toBe(403);
  });

  it("keeps launch reads inside project access", async () => {
    const f = await fixture();
    const missing = await f.request(f.owner, "GET", `launches/${randomUlid()}`);
    expect(missing.status).toBe(404);
    const noTask = await f.request(f.owner, "GET", `launches?task_id=${randomUlid()}`);
    expect(noTask.status).toBe(404);
    const projectBTask = success(
      await f.human(createTaskCommand, {
        projectId: FIX.projectB,
        title: "Synthetic B",
        priority: "P2",
      }),
    );
    const crossed = await f.request(f.restricted, "GET", `launches?task_id=${projectBTask.id}`);
    expect(crossed.status).toBe(404);
  });

  it("charges status reads as polls, not command attempts", async () => {
    const f = await fixture();
    const started = await f.request(f.owner, "POST", "launches", f.start);
    expect(started.status).toBe(201);
    const created = (await started.json()) as { launch_id: string };
    for (let index = 0; index < 25; index += 1) {
      const read = await f.request(f.owner, "GET", `launches/${created.launch_id}`);
      expect(read.status).toBe(200);
    }
    const listed = await f.request(f.owner, "GET", `launches?task_id=${f.start.task_id}`);
    expect(listed.status).toBe(200);
    const checkouts = await f.request(f.owner, "GET", `runners/${f.runner}/checkouts`);
    expect(checkouts.status).toBe(200);
  });

  it("rejects reviewer and ungranted starts while the owner starts once", async () => {
    const f = await fixture();
    expect((await f.request(f.restricted, "POST", "launches", f.start)).status).toBe(403);
    expect((await f.request(f.member, "POST", "launches", f.start)).status).toBe(403);
    const first = await f.request(f.owner, "POST", "launches", f.start);
    expect(first.status, await first.clone().text()).toBe(201);
    const created = (await first.json()) as { launch_id: string; state: string };
    expect(created.state).toBe("pending");
    const status = await f.request(f.owner, "GET", `launches/${created.launch_id}`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      launch: {
        launch_id: created.launch_id,
        state: "pending",
        execution_state: "queued",
        result_state: "open",
        lease_state: null,
      },
    });
  });

  it("treats double Start as one effective launch", async () => {
    const f = await fixture();
    const first = await f.request(f.owner, "POST", "launches", f.start);
    const second = await f.request(f.owner, "POST", "launches", f.start);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(((await second.json()) as { launch_id: string }).launch_id).toBe(
      ((await first.json()) as { launch_id: string }).launch_id,
    );
    const changed: LaunchStartRequest = {
      ...f.start,
      checkout_id: randomUlid(),
    };
    expect((await f.request(f.owner, "POST", "launches", changed)).status).toBe(403);
    const retried: LaunchStartRequest = { ...f.start, idempotency_key: randomUlid() };
    expect((await f.request(f.owner, "POST", "launches", retried)).status).toBe(403);
    const listed = (await (
      await f.request(f.owner, "GET", `launches?task_id=${f.start.task_id}`)
    ).json()) as { launches: unknown[] };
    expect(listed.launches).toHaveLength(1);
  });

  it("shows claimed launches with their reserved fence", async () => {
    const f = await fixture();
    const started = await f.request(f.owner, "POST", "launches", f.start);
    expect(started.status).toBe(201);
    const claimed = await f.claim();
    const status = await f.request(f.owner, "GET", `launches/${claimed.launch.launch_id}`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      launch: {
        launch_id: claimed.launch.launch_id,
        state: "claimed",
        execution_state: "launching",
        lease_state: "reserved",
        result_state: "open",
        provider: "fake",
        model: "synthetic",
      },
    });
  });

  it("requires another explicit click after expiry and supports retry_run_id", async () => {
    const f = await fixture();
    const started = (await (await f.request(f.owner, "POST", "launches", f.start)).json()) as {
      launch_id: string;
      run_id: string;
    };
    const expiredAt = new Date(Date.parse(LAUNCH_NOW) + 130_000).toISOString();
    const claim: LaunchClaim = {
      schema_version: 1,
      launch_id: started.launch_id,
      runner_id: f.runner,
      idempotency_key: randomUlid(),
      claimed_at: expiredAt,
    };
    const outcome = success(
      await f.native(claimLaunchCommand, { principal: f.principal, claim }, expiredAt),
    );
    expect(outcome.state).toBe("expired");
    const status = (await (
      await f.request(f.owner, "GET", `launches/${started.launch_id}`)
    ).json()) as {
      launch: { state: string; end_reason: string; execution_state: string; result_state: string };
    };
    expect(status.launch).toMatchObject({
      state: "expired",
      end_reason: "launch_expired",
      execution_state: "ended",
      result_state: "open",
    });
    const task = (await f.context.db
      .prepare(`SELECT state, resource_version FROM tasks WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, f.start.task_id)) as { state: string; resource_version: number };
    expect(task.state).toBe("ready");
    const retry: LaunchStartRequest = {
      ...f.start,
      idempotency_key: randomUlid(),
      expected_task_version: task.resource_version,
      retry_run_id: started.run_id,
    };
    const again = await f.request(f.owner, "POST", "launches", retry);
    expect(again.status, await again.clone().text()).toBe(201);
    expect(((await again.json()) as { launch_id: string }).launch_id).not.toBe(started.launch_id);
  });

  it("keeps containment_unknown blocked with a typed reason and no web clear path", async () => {
    const f = await fixture();
    await f.request(f.owner, "POST", "launches", f.start);
    const claimed = await f.claim();
    const escaped: CheckoutLeaseObservation = {
      schema_version: 1,
      run_execution_id: claimed.final.run_execution_id,
      assignment_generation: claimed.final.assignment_generation,
      fencing_generation: claimed.final.fencing_generation,
      sequence: 1,
      observed_at: LAUNCH_NOW,
      operation: "renew",
      supervisor: claimed.final.supervisor,
      local_lock_id: claimed.final.local_lock_id,
      owned_group_id: 1235,
      owned_group_start_identity: "123456:2000",
      supervisor_state: "verified",
      group_state: "live",
      lock_state: "held",
      descendants_state: "escaped",
      recovery_local: false,
    };
    const observed = success(
      await f.native(observeCheckoutLeaseCommand, { principal: f.principal, observation: escaped }),
    );
    expect(observed.state).toBe("containment_unknown");
    const status = (await (
      await f.request(f.owner, "GET", `launches/${claimed.launch.launch_id}`)
    ).json()) as {
      launch: { lease_state: string; containment_reason: string; result_state: string };
    };
    expect(status.launch.lease_state).toBe("containment_unknown");
    expect(status.launch.containment_reason).toBe("escaped_descendant");
    expect(status.launch.result_state).toBe("open");
    for (const key of keysOf(status)) {
      expect(/clear/i.test(key), `web-clearable field: ${key}`).toBe(false);
    }
    const cleared = await f.request(f.owner, "POST", "launches/clear", {
      launch_id: claimed.launch.launch_id,
    });
    expect(cleared.status).toBe(403);
  });

  it("keeps wake hints out of launch authority", async () => {
    const f = await fixture();
    const started = (await (await f.request(f.owner, "POST", "launches", f.start)).json()) as {
      launch_id: string;
    };
    const first = await f.request(f.owner, "POST", "launches/wake", {
      schema_version: 1,
      launch_id: started.launch_id,
    });
    expect(first.status, await first.clone().text()).toBe(201);
    const hint = (await first.json()) as {
      intent_kind: string;
      intent_id: string;
      launch_id: string;
    };
    expect(hint.intent_kind).toBe("cloud_wake");
    const second = (await (
      await f.request(f.owner, "POST", "launches/wake", {
        schema_version: 1,
        launch_id: started.launch_id,
      })
    ).json()) as { launch_id: string };
    expect(second.launch_id).toBe(started.launch_id);
    const status = (await (
      await f.request(f.owner, "GET", `launches/${started.launch_id}`)
    ).json()) as { launch: Record<string, unknown> };
    expect(status.launch.state).toBe("pending");
    for (const key of keysOf(status)) {
      expect(/wake|intent/i.test(key), `wake value in launch read: ${key}`).toBe(false);
    }
    const smuggled = await f.request(
      f.owner,
      "POST",
      "launches",
      { ...f.start, idempotency_key: randomUlid(), wake_intent_id: hint.intent_id },
      undefined,
    );
    expect(smuggled.status).toBe(403);
  });

  it("binds run controls to one immutable assignment with one disposition", async () => {
    const f = await fixture();
    await f.request(f.owner, "POST", "launches", f.start);
    const claimed = await f.claim();
    const key = randomUlid();
    const control = {
      schema_version: 1,
      idempotency_key: key,
      runner_id: f.runner,
      run_execution_id: claimed.final.run_execution_id,
      assignment_generation: claimed.final.assignment_generation,
      action: "cancel",
    };
    const first = await f.request(f.owner, "POST", "run-controls", control);
    expect(first.status, await first.clone().text()).toBe(201);
    const created = (await first.json()) as { control_id: string; state: string };
    expect(created.state).toBe("pending");
    const second = (await (await f.request(f.owner, "POST", "run-controls", control)).json()) as {
      control_id: string;
    };
    expect(second.control_id).toBe(created.control_id);
    const interruptReserved = await f.request(f.owner, "POST", "run-controls", {
      ...control,
      idempotency_key: randomUlid(),
      action: "interrupt",
    });
    expect(interruptReserved.status).toBe(403);
    const stale = await f.request(f.owner, "POST", "run-controls", {
      ...control,
      idempotency_key: randomUlid(),
      assignment_generation: claimed.final.assignment_generation + 1,
    });
    expect(stale.status).toBe(403);
    const foreign = await f.request(f.owner, "POST", "run-controls", {
      ...control,
      idempotency_key: randomUlid(),
      run_execution_id: randomUlid(),
    });
    expect(foreign.status).toBe(403);
  });

  it("leaves task and result open when the process ends", async () => {
    const f = await fixture();
    await f.request(f.owner, "POST", "launches", f.start);
    const claimed = await f.claim();
    success(
      await f.native(authorizeLaunchCommand, {
        principal: f.principal,
        authorization: claimed.final,
      }),
    );
    const renew: CheckoutLeaseObservation = {
      schema_version: 1,
      run_execution_id: claimed.final.run_execution_id,
      assignment_generation: claimed.final.assignment_generation,
      fencing_generation: claimed.final.fencing_generation,
      sequence: 1,
      observed_at: LAUNCH_NOW,
      operation: "renew",
      supervisor: claimed.final.supervisor,
      local_lock_id: claimed.final.local_lock_id,
      owned_group_id: 1235,
      owned_group_start_identity: "123456:2000",
      supervisor_state: "verified",
      group_state: "live",
      lock_state: "held",
      descendants_state: "contained",
      recovery_local: false,
    };
    expect(
      success(
        await f.native(observeCheckoutLeaseCommand, { principal: f.principal, observation: renew }),
      ).state,
    ).toBe("live");
    const release: CheckoutLeaseObservation = {
      ...renew,
      sequence: 2,
      operation: "release",
      supervisor_state: "gone",
      group_state: "gone",
      lock_state: "gone",
      descendants_state: "gone",
    };
    expect(
      success(
        await f.native(observeCheckoutLeaseCommand, {
          principal: f.principal,
          observation: release,
        }),
      ).state,
    ).toBe("released");
    const status = (await (
      await f.request(f.owner, "GET", `launches/${claimed.launch.launch_id}`)
    ).json()) as {
      launch: { execution_state: string; execution_end_reason: string; result_state: string };
    };
    expect(status.launch).toMatchObject({
      execution_state: "ended",
      execution_end_reason: "process_exit",
      result_state: "open",
    });
    const task = (await f.context.db
      .prepare(`SELECT state FROM tasks WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, f.start.task_id)) as { state: string };
    expect(task.state).not.toBe("done");
  });
});

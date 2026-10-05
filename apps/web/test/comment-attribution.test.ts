// ABOUTME: Proves normal browser comment reads and actual UI author labels preserve run provenance.
// ABOUTME: Creates the agent comment through WorkspaceHub and keeps legacy null authors unknown.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIX,
  agentSessionBindKey,
  agentWorkKey,
  bindAgentSessionCommand,
  agentRunCommentCommand,
  addCommentCommand,
  authorizeLaunchCommand,
  observeCheckoutLeaseCommand,
  randomUlid,
} from "@bfb/domain";
import {
  LAUNCH_NOW,
  launchFixture,
  success,
} from "../../../packages/domain/test/launch-fixture.js";
import { parseAuthKeys } from "../../control-worker/src/auth/better-auth.js";
import { createControlApp } from "../../control-worker/src/routes.js";
import { validateControlEnv, type ControlBindings } from "../../control-worker/src/env.js";
import { createTestWorkspaceHubNamespace } from "../../control-worker/src/hub-client.js";
import {
  AUTH_TEST_ENV,
  openAuthTestContext,
  seedAuthSession,
} from "../../control-worker/test/auth-helpers.js";
import { CommentAuthor } from "../src/work/mutations.js";

afterEach(() => vi.useRealTimers());
describe("truthful comment authors", () => {
  it("renders Agent run, Human, Delegated client and Unknown from ordinary authenticated GET", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(LAUNCH_NOW));
    const context = openAuthTestContext(LAUNCH_NOW),
      f = await launchFixture(context.db),
      c = await f.claim();
    try {
      success(
        await f.native(authorizeLaunchCommand, { principal: f.principal, authorization: c.final }),
      );
      success(
        await f.native(observeCheckoutLeaseCommand, {
          principal: f.principal,
          observation: {
            schema_version: 1,
            run_execution_id: c.final.run_execution_id,
            assignment_generation: c.final.assignment_generation,
            fencing_generation: c.final.fencing_generation,
            sequence: 1,
            observed_at: LAUNCH_NOW,
            operation: "renew",
            supervisor: c.final.supervisor,
            local_lock_id: c.final.local_lock_id,
            owned_group_id: 1235,
            owned_group_start_identity: "123456:2000",
            supervisor_state: "verified",
            group_state: "live",
            lock_state: "held",
            descendants_state: "contained",
            recovery_local: false,
          },
        }),
      );
      const reference = {
        schema_version: 1 as const,
        run_execution_id: c.final.run_execution_id,
        assignment_generation: c.final.assignment_generation,
        request_id: "attribution-bind-01",
      };
      const envelope = {
        workspaceId: FIX.workspace,
        actorRunnerId: f.runner,
        authorizationEpoch: 1,
        now: LAUNCH_NOW,
      };
      const bound = success(
        await f.hub.execute(bindAgentSessionCommand, {
          ...envelope,
          idempotencyKey: agentSessionBindKey(reference),
          input: {
            principal: f.principal,
            request: {
              reference,
              observation: {
                provider: "fake",
                observed_session_id: "synthetic-attribution-session",
                observed_at: LAUNCH_NOW,
              },
            },
          },
        }),
      );
      const commentReference = { ...reference, request_id: "attribution-comment-01" };
      const agent = success(
        await f.hub.execute(agentRunCommentCommand, {
          ...envelope,
          idempotencyKey: agentWorkKey("comment", commentReference),
          input: {
            principal: f.principal,
            request: {
              reference: commentReference,
              binding: bound.binding,
              body: "Synthetic agent note",
            },
          },
        }),
      );
      const human = success(
        await f.human(addCommentCommand, {
          taskId: f.task.id,
          body: "Synthetic human note",
          kind: "discussion",
        }),
      );
      const delegation = randomUlid(),
        delegated = randomUlid(),
        unknown = randomUlid();
      await f.db
        .prepare(
          "INSERT INTO oauth_delegations (workspace_id,id,human_id,client_id,resource,scopes_json,authorization_epoch,expires_at,created_at) VALUES (?, ?, ?, 'synthetic-client', 'synthetic-resource', '[]', 1, '2027-01-01T00:00:00Z', ?)",
        )
        .run(FIX.workspace, delegation, FIX.owner, LAUNCH_NOW);
      await f.db
        .prepare(
          "INSERT INTO comments (workspace_id,id,task_id,author_human_id,author_delegation_id,body,kind,created_at) VALUES (?, ?, ?, NULL, ?, 'Synthetic delegated note', 'discussion', ?)",
        )
        .run(FIX.workspace, delegated, f.task.id, delegation, LAUNCH_NOW);
      await f.db
        .prepare(
          "INSERT INTO comments (workspace_id,id,task_id,body,kind,created_at) VALUES (?, ?, ?, 'Synthetic legacy note', 'discussion', ?)",
        )
        .run(FIX.workspace, unknown, f.task.id, LAUNCH_NOW);
      const session = await seedAuthSession(context, { humanId: FIX.owner, now: LAUNCH_NOW });
      const env = {
        DB: {},
        ARTIFACTS: {},
        ASSETS: {},
        JOBS: {},
        JOBS_DLQ: {},
        WORKSPACE_HUB: createTestWorkspaceHubNamespace(f.db),
        APP_ORIGIN: AUTH_TEST_ENV.APP_ORIGIN,
        ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
        LAUNCH_ORIGIN: "https://launch.bfb.example.test",
        JURISDICTION: "eu",
        ENVIRONMENT: "local",
      } as unknown as ControlBindings;
      const app = createControlApp(validateControlEnv(env), {
        db: f.db,
        now: LAUNCH_NOW,
        humanAuth: () => ({
          auth: context.auth,
          keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
          abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
        }),
      });
      const response = await app.request(
        new Request(
          AUTH_TEST_ENV.APP_ORIGIN +
            "/api/v1/workspaces/" +
            FIX.workspace +
            "/tasks/" +
            f.task.id +
            "/comments",
          { headers: { cookie: session.cookie } },
        ),
        undefined,
        env,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      type Comment = {
        id: string;
        author_kind: "human" | "delegated_human" | "agent_run" | "unknown";
        author_run_id: string | null;
        author_execution_id: string | null;
        author_provider_session_id: string | null;
        author_human_id: string | null;
        author_delegation_id: string | null;
      };
      const comments = ((await response.json()) as { comments: Comment[] }).comments;
      const byId = new Map(comments.map((comment) => [comment.id, comment]));
      expect(byId.get(agent.id)).toMatchObject({
        author_kind: "agent_run",
        author_run_id: c.launch.run_id,
        author_execution_id: c.final.run_execution_id,
        author_provider_session_id: bound.binding.provider_session_id,
        author_human_id: null,
        author_delegation_id: null,
      });
      for (const [id, label] of [
        [agent.id, "Agent run " + c.launch.run_id],
        [human.id, "Human"],
        [delegated, "Delegated client"],
        [unknown, "Unknown"],
      ] as const) {
        const comment = byId.get(id);
        expect(comment).toBeDefined();
        expect(renderToStaticMarkup(createElement(CommentAuthor, { comment: comment! }))).toBe(
          "<span>" + label + "</span>",
        );
      }
      expect(
        await f.db
          .prepare("SELECT created_by_human_id, created_by_delegation_id FROM tasks WHERE id = ?")
          .get(f.task.id),
      ).toEqual({ created_by_human_id: FIX.owner, created_by_delegation_id: null });
    } finally {
      context.raw.close();
    }
  });
});

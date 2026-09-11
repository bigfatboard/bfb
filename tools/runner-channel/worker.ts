// ABOUTME: Hosts production runner routes and the real hibernating hub for local interoperability acceptance.
// ABOUTME: Synthetic fixture endpoints mint test proofs, lose nudges and expose bounded assertion data only.

import { createFetchHandler, WorkspaceHub } from "@bfb/control-worker";
import { adaptD1, type D1Like } from "@bfb/db";
import {
  FIX,
  canonicalRunnerKey,
  issueStepUpProof,
  runnerEnrollmentTarget,
  runnerGrantsTarget,
  runnerId,
  type RunnerPublicKey,
} from "@bfb/domain";

export { WorkspaceHub };
let tokenClockOffset = 0;

export default {
  async fetch(request: Request, env: { DB: D1Like; APP_ORIGIN: string }): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/__test/")) {
      const now = new Date(Date.now() + tokenClockOffset).toISOString();
      return createFetchHandler({ now })(request, env as never);
    }
    const db = adaptD1(env.DB);
    const input = (await request.json()) as Record<string, unknown>;
    const now = new Date().toISOString();
    if (path === "/__test/time") {
      const offset = Number(input.offset);
      if (offset !== 0 && offset !== -290_000) return new Response(null, { status: 400 });
      tokenClockOffset = offset;
      return Response.json({ changed: true });
    }
    const workspace = runnerId(input.workspace_id);
    const runner = runnerId(input.runner_id);
    if (path === "/__test/proof") {
      const action = input.action;
      let target: string;
      if (action === "runner.enroll") {
        target = runnerEnrollmentTarget({
          runnerId: runner,
          deviceLabel: String(input.device_label),
          publicKey: await canonicalRunnerKey(input.public_key as RunnerPublicKey),
          projectIds: input.project_ids as string[],
        });
      } else if (action === "runner.grants.replace") {
        target = runnerGrantsTarget({
          runnerId: runner,
          expectedGrantEpoch: Number(input.expected_grant_epoch),
          projectIds: input.project_ids as string[],
          launcherHumanIds: [FIX.owner],
        });
      } else if (action === "runner.revoke") {
        target = runner;
      } else return new Response(null, { status: 400 });
      const proof = await issueStepUpProof(
        db,
        FIX.owner,
        {
          action,
          targetId: target,
          workspaceId: workspace,
          scopes: [],
          authorizationEpoch: 1,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        now,
      );
      return Response.json({ proof });
    }
    if (path === "/__test/commands") {
      const commands = input.commands as {
        command_id: string;
        command_kind: string;
        project_id: string;
        expires_at: string;
      }[];
      if (commands.length > 30) return new Response(null, { status: 400 });
      for (const command of commands) {
        await db
          .prepare(
            `INSERT INTO runner_command_references (workspace_id,runner_id,command_id,command_kind,project_id,created_at,expires_at) VALUES (?,?,?,?,?,?,?)`,
          )
          .run(
            workspace,
            runner,
            runnerId(command.command_id),
            command.command_kind,
            runnerId(command.project_id),
            now,
            command.expires_at,
          );
      }
      // Intentionally no hub invocation: this creates the lost-nudge case.
      return Response.json({ inserted: commands.length });
    }
    if (path === "/__test/observe") {
      const connection = await db
        .prepare(
          `SELECT connection_id, token_epoch, last_seen_at, auth_expires_at FROM runner_connections WHERE workspace_id = ? AND runner_id = ?`,
        )
        .get(workspace, runner);
      const inventory = (await db
        .prepare(
          `SELECT inventory_json FROM runner_inventories WHERE workspace_id = ? AND runner_id = ?`,
        )
        .get(workspace, runner)) as { inventory_json: string } | undefined;
      const authority = await db
        .prepare(
          `SELECT authorization_epoch, grant_epoch, token_epoch, revoked_at FROM runners WHERE workspace_id = ? AND id = ?`,
        )
        .get(workspace, runner);
      const pending = await db
        .prepare(
          `SELECT command_id FROM runner_command_references WHERE workspace_id = ? AND runner_id = ? AND resolved_at IS NULL ORDER BY command_id`,
        )
        .all(workspace, runner);
      return Response.json({
        connection,
        inventory: inventory ? JSON.parse(inventory.inventory_json) : null,
        authority,
        pending,
      });
    }
    return new Response(null, { status: 404 });
  },
};

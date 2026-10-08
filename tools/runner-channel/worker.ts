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
  randomUlid,
  runnerHash,
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
        private?: boolean;
      }[];
      if (commands.length > 30) return new Response(null, { status: 400 });
      const owner = (await db
        .prepare(
          `SELECT key_thumbprint,authorization_epoch,grant_epoch FROM runners WHERE workspace_id=? AND id=?`,
        )
        .get(workspace, runner)) as {
        key_thumbprint: string;
        authorization_epoch: number;
        grant_epoch: number;
      };
      for (const command of commands) {
        // Transport fixtures require canonical shared parents; no provider is launched by these rows.
        if (command.command_kind !== "launch") return new Response(null, { status: 400 });
        const task = randomUlid(),
          run = randomUlid(),
          execution = randomUlid(),
          snapshot = randomUlid();
        const project = runnerId(command.project_id),
          digest = `sha256:${"a".repeat(64)}`;
        await db
          .prepare(
            `INSERT INTO tasks (workspace_id,id,project_id,title,state,priority,next_owner_type,punchline,created_by_human_id,created_at)
           VALUES (?,?,?,'Synthetic channel delivery','active','P2','unassigned','Synthetic transport only',?,?)`,
          )
          .run(workspace, task, project, FIX.owner, now);
        if (command.private)
          await db
            .prepare(
              `INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)`,
            )
            .run(workspace, task, FIX.owner, now);
        await db
          .prepare(
            `INSERT INTO runs (workspace_id,id,project_id,task_id,requested_by_human_id,agent_profile_id,result_state,activity,created_at)
           VALUES (?,?,?,?,?,?,'open','unknown',?)`,
          )
          .run(workspace, run, project, task, FIX.owner, FIX.profileCodex, now);
        await db
          .prepare(
            `INSERT INTO run_executions (workspace_id,id,run_id,state,created_at) VALUES (?,?,?,'queued',?)`,
          )
          .run(workspace, execution, run, now);
        await db
          .prepare(
            `INSERT INTO run_configuration_snapshots
           (workspace_id,id,project_id,run_id,workspace_policy_version,project_policy_version,repository_config_version,
            agent_profile_id,agent_profile_version,canonical_json,content_hash,created_at)
           VALUES (?,?,?,?,1,1,1,?,1,'{}',?,?)`,
          )
          .run(workspace, snapshot, project, run, FIX.profileCodex, digest, now);
        await db
          .prepare(
            `INSERT INTO execution_assignments (workspace_id,execution_id,assignment_generation,run_id,task_id,project_id,
           runner_id,checkout_id,physical_worktree_hash,requesting_human_id,requesting_human_epoch,
           runner_authorization_epoch,runner_grant_epoch,runner_key_thumbprint,created_at)
           VALUES (?,?,1,?,?,?,?,?,?,?,1,?,?,?,?)`,
          )
          .run(
            workspace,
            execution,
            run,
            task,
            project,
            runner,
            randomUlid(),
            digest,
            FIX.owner,
            owner.authorization_epoch,
            owner.grant_epoch,
            owner.key_thumbprint,
            now,
          );
        await db
          .prepare(
            `INSERT INTO launch_commands (workspace_id,id,execution_id,assignment_generation,run_id,requesting_human_id,
           idempotency_key_hash,request_hash,state,snapshot_id,created_at,expires_at)
           VALUES (?,?,?,1,?,?,?,?,'pending',?,?,?)`,
          )
          .run(
            workspace,
            command.command_id,
            execution,
            run,
            FIX.owner,
            runnerHash(command.command_id),
            "a".repeat(64),
            snapshot,
            now,
            command.expires_at,
          );
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

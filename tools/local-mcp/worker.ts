// ABOUTME: Hosts production agent work routes and synthetic canonical execution fixtures for A01.
// ABOUTME: Exposes test-only seed, observation and authority-change endpoints on disposable local D1.

import channelWorker, { WorkspaceHub } from "../runner-channel/worker.js";
import { adaptD1, type D1Like } from "@bfb/db";
import { FIX, randomUlid, runnerId } from "@bfb/domain";
import { createHash } from "node:crypto";

export { WorkspaceHub };
const hash = (body: string) => `sha256:${createHash("sha256").update(body).digest("hex")}`;

export default {
  async fetch(request: Request, env: { DB: D1Like; APP_ORIGIN: string }): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/__a01/")) return channelWorker.fetch(request, env);
    const db = adaptD1(env.DB),
      input = (await request.json()) as Record<string, string>;
    const workspace = FIX.workspace,
      now = new Date().toISOString();
    if (path === "/__a01/seed") {
      const runner = runnerId(input.runner),
        task = randomUlid(),
        run = randomUlid(),
        execution = randomUlid();
      const checkout = randomUlid(),
        snapshot = randomUlid(),
        launch = randomUlid(),
        physical = hash(execution);
      const enrolled = (await db
        .prepare(
          `SELECT key_thumbprint, authorization_epoch, grant_epoch FROM runners WHERE workspace_id = ? AND id = ?`,
        )
        .get(workspace, runner)) as {
        key_thumbprint: string;
        authorization_epoch: number;
        grant_epoch: number;
      };
      if (!enrolled) return new Response(null, { status: 400 });
      await db
        .prepare(
          `INSERT INTO tasks (workspace_id,id,project_id,title,state,priority,next_owner_type,punchline,created_by_human_id,created_at) VALUES (?,?,?,'Synthetic private task','active','P2','unassigned','Synthetic private punchline',?,?)`,
        )
        .run(workspace, task, FIX.projectA, FIX.owner, now);
      await db
        .prepare(
          `INSERT INTO runs (workspace_id,id,project_id,task_id,requested_by_human_id,agent_profile_id,result_state,activity,created_at) VALUES (?,?,?,?,?,?,'open','unknown',?)`,
        )
        .run(workspace, run, FIX.projectA, task, FIX.owner, FIX.profileCodex, now);
      await db
        .prepare(
          `INSERT INTO run_configuration_snapshots (workspace_id,id,project_id,run_id,workspace_policy_version,project_policy_version,repository_config_version,agent_profile_id,agent_profile_version,canonical_json,content_hash,created_at) VALUES (?,?,?,?,1,1,1,?,1,'{}',?,?)`,
        )
        .run(workspace, snapshot, FIX.projectA, run, FIX.profileCodex, hash("{}"), now);
      await db
        .prepare(
          `INSERT INTO run_executions (workspace_id,id,run_id,state,created_at) VALUES (?,?,?,'attached',?)`,
        )
        .run(workspace, execution, run, now);
      await db
        .prepare(
          `INSERT INTO execution_assignments (workspace_id,execution_id,assignment_generation,run_id,task_id,project_id,runner_id,checkout_id,physical_worktree_hash,requesting_human_id,requesting_human_epoch,runner_authorization_epoch,runner_grant_epoch,runner_key_thumbprint,created_at) VALUES (?,?,1,?,?,?,?,?,?,?,1,?,?,?,?)`,
        )
        .run(
          workspace,
          execution,
          run,
          task,
          FIX.projectA,
          runner,
          checkout,
          physical,
          FIX.owner,
          enrolled.authorization_epoch,
          enrolled.grant_epoch,
          enrolled.key_thumbprint,
          now,
        );
      await db
        .prepare(
          `INSERT INTO launch_commands (workspace_id,id,execution_id,assignment_generation,run_id,requesting_human_id,idempotency_key_hash,request_hash,state,snapshot_id,created_at,expires_at,final_authorized_at) VALUES (?,?,?,1,?,?,?,?,'started',?,?,?,?)`,
        )
        .run(
          workspace,
          launch,
          execution,
          run,
          FIX.owner,
          hash(launch).slice(7),
          hash(execution).slice(7),
          snapshot,
          now,
          new Date(Date.now() + 600_000).toISOString(),
          now,
        );
      await db
        .prepare(
          `INSERT INTO checkout_leases (workspace_id,runner_id,physical_worktree_hash,execution_id,assignment_generation,fencing_generation,state,expires_at) VALUES (?,?,?,?,1,1,'live',?)`,
        )
        .run(workspace, runner, physical, execution, new Date(Date.now() + 600_000).toISOString());
      for (const [index, audience] of ["agent", "human", "both"].entries()) {
        const body = `Synthetic ${audience} context`;
        await db
          .prepare(
            `INSERT INTO task_context_items (workspace_id,id,task_id,kind,audience,body,version,content_hash,created_at) VALUES (?,?,?,'brief',?,?,?,?,?)`,
          )
          .run(workspace, randomUlid(), task, audience, body, index + 1, hash(body), now);
      }
      return Response.json({
        workspace,
        project: FIX.projectA,
        task,
        run,
        execution,
        runner,
        checkout,
        launch,
        physical,
      });
    }
    const execution = runnerId(input.execution);
    const row = (await db
      .prepare(
        `SELECT run_id,task_id,runner_id FROM execution_assignments WHERE workspace_id = ? AND execution_id = ?`,
      )
      .get(workspace, execution)) as { run_id: string; task_id: string; runner_id: string };
    if (!row) return new Response(null, { status: 404 });
    if (path === "/__a01/oversize") {
      const body = "<".repeat(12_000);
      await db
        .prepare(
          `INSERT INTO task_context_items (workspace_id,id,task_id,kind,audience,body,version,content_hash,created_at) VALUES (?,?,?,'note','agent',?,4,?,?)`,
        )
        .run(workspace, randomUlid(), row.task_id, body, hash(body), now);
      return Response.json({ inserted: true });
    }
    if (path === "/__a01/change") {
      if (input.kind === "grant")
        await db
          .prepare(
            `DELETE FROM runner_launch_grants WHERE workspace_id = ? AND runner_id = ? AND human_id = ?`,
          )
          .run(workspace, row.runner_id, FIX.owner);
      else if (input.kind === "lease")
        await db
          .prepare(
            `UPDATE checkout_leases SET expires_at = ? WHERE workspace_id = ? AND execution_id = ?`,
          )
          .run(new Date(Date.now() - 1000).toISOString(), workspace, execution);
      else if (input.kind === "result")
        await db
          .prepare(`UPDATE runs SET result_state = 'accepted' WHERE workspace_id = ? AND id = ?`)
          .run(workspace, row.run_id);
      else if (input.kind === "end")
        await db
          .prepare(
            `UPDATE run_executions SET state = 'ended', end_reason = 'process_exit', ended_at = ? WHERE workspace_id = ? AND id = ?`,
          )
          .run(now, workspace, execution);
      else return new Response(null, { status: 400 });
      return Response.json({ changed: true });
    }
    if (path === "/__a01/observe") {
      const deliveries = await db
        .prepare(
          `SELECT id,context_version,content_hash,delivered_at,run_id FROM task_context_deliveries WHERE workspace_id = ? AND run_id = ? ORDER BY context_version`,
        )
        .all(workspace, row.run_id);
      const sessions = await db
        .prepare(
          `SELECT count(*) AS count FROM provider_sessions WHERE workspace_id = ? AND run_id = ?`,
        )
        .get(workspace, row.run_id);
      const task = await db
        .prepare(
          `SELECT title,punchline,state,resource_version FROM tasks WHERE workspace_id = ? AND id = ?`,
        )
        .get(workspace, row.task_id);
      const commentCount = (await db
        .prepare(`SELECT count(*) AS count FROM comments WHERE workspace_id = ? AND task_id = ?`)
        .get(workspace, row.task_id)) as { count: number };
      const taskCount = (await db
        .prepare(`SELECT count(*) AS count FROM tasks WHERE workspace_id = ?`)
        .get(workspace)) as { count: number };
      return Response.json({
        deliveries,
        sessions,
        business: { task, comments: commentCount.count, tasks: taskCount.count },
      });
    }
    return new Response(null, { status: 404 });
  },
};

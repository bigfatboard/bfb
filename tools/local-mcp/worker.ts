// ABOUTME: Hosts production agent work routes and synthetic execution fixtures for A01 and A02.
// ABOUTME: Exposes test-only seed, observation and authority-change endpoints on disposable local D1.

import channelWorker, { WorkspaceHub } from "../runner-channel/worker.js";
import { adaptD1, type D1Like } from "@bfb/db";
import {
  FIX,
  randomUlid,
  runnerId,
  canonicalLaunchJson,
  WorkspaceHub as DomainHub,
  authorizeSyntheticPolicyUpdate,
  updateWorkspacePolicyCommand,
  updateProjectPolicyCommand,
  reportRepositoryConfigCommand,
  getWorkspacePolicy,
  getProjectPolicy,
  normalizeRepositoryConfig,
  repositoryConfigPolicyTarget,
  issueStepUpProof,
  OFFLINE_AGENT_TOOLS,
  createAgentProfileCommand,
  type HubCommand,
  type PolicySettings,
} from "@bfb/domain";
import { decodeWireDocument, type LaunchClaimResult } from "@bfb/protocol";
import { createHash } from "node:crypto";

export { WorkspaceHub };
const hash = (body: string) => `sha256:${createHash("sha256").update(body).digest("hex")}`;

export default {
  async fetch(request: Request, env: { DB: D1Like; APP_ORIGIN: string }): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/__a01/") && !path.startsWith("/__a02/"))
      return channelWorker.fetch(request, env);
    const db = adaptD1(env.DB),
      input = (await request.json()) as Record<string, string>;
    const workspace = FIX.workspace,
      now = new Date().toISOString();
    const hub = new DomainHub(db);
    const human = async <I, R>(command: HubCommand<I, R>, value: I): Promise<R> => {
      const outcome = await hub.execute(command, {
        workspaceId: workspace,
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        now,
        input: value,
      });
      if (!outcome.ok) throw new Error(`synthetic policy configuration ${outcome.error.code}`);
      return outcome.result;
    };
    if (path === "/__a01/project-tighten") {
      const { resourceVersion, ...current } = await getProjectPolicy(db, workspace, FIX.projectA);
      const settings = {
        ...current,
        offlineAgentWork: {
          ...current.offlineAgentWork,
          max_pending_age_seconds: current.offlineAgentWork.max_pending_age_seconds - 1,
        },
        expectedVersion: resourceVersion,
        projectId: FIX.projectA,
      };
      const input = await authorizeSyntheticPolicyUpdate(
        db,
        { workspaceId: workspace, humanId: FIX.owner },
        settings,
      );
      return Response.json(await human(updateProjectPolicyCommand, input));
    }
    if (path === "/__a01/configure") {
      const permission =
        input.offline === "allow"
          ? {
              allowed_tools: [...OFFLINE_AGENT_TOOLS],
              max_pending_age_seconds: Number(input.age ?? "300"),
            }
          : { allowed_tools: [], max_pending_age_seconds: 0 };
      const settings: PolicySettings = {
        allowedProviders: ["fake"],
        allowAgentRootPropose: false,
        allowPassToAgent: true,
        allowRunOverrides: false,
        offlineAgentWork: permission,
      };
      for (const project of [false, true]) {
        const current = project
          ? await getProjectPolicy(db, workspace, FIX.projectA)
          : await getWorkspacePolicy(db, workspace);
        const value = await authorizeSyntheticPolicyUpdate(
          db,
          { workspaceId: workspace, humanId: FIX.owner },
          {
            ...settings,
            expectedVersion: current.resourceVersion,
            ...(project ? { projectId: FIX.projectA } : {}),
          },
        );
        if (project) await human(updateProjectPolicyCommand, { ...value, projectId: FIX.projectA });
        else await human(updateWorkspacePolicyCommand, value);
      }
      const repository = (await db
        .prepare(
          "SELECT resource_version FROM repository_configs WHERE workspace_id=? AND project_id=?",
        )
        .get(workspace, FIX.projectA)) as { resource_version: number };
      const document = { offline_agent_work: permission };
      const canonical = normalizeRepositoryConfig(document, settings).canonical;
      const contentHash = hash(canonical);
      const stepUpProofId = await issueStepUpProof(
        db,
        FIX.owner,
        {
          action: "repository.config.report",
          workspaceId: workspace,
          projectId: FIX.projectA,
          targetId: repositoryConfigPolicyTarget(
            workspace,
            FIX.projectA,
            repository.resource_version,
            contentHash,
            permission,
          ),
          scopes: [],
          authorizationEpoch: 1,
          expiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
        },
        now,
      );
      await human(reportRepositoryConfigCommand, {
        projectId: FIX.projectA,
        expectedVersion: repository.resource_version,
        document,
        contentHash,
        stepUpProofId,
      });
      await db
        .prepare(
          "UPDATE projects SET repository_host='synthetic',repository_subpath='.' WHERE workspace_id=? AND id=?",
        )
        .run(workspace, FIX.projectA);
      if (
        !(await db
          .prepare(
            "SELECT id FROM agent_profiles WHERE workspace_id=? AND provider='fake' AND model='synthetic'",
          )
          .get(workspace))
      )
        await human(createAgentProfileCommand, {
          name: "Synthetic native provider",
          provider: "fake",
          model: "synthetic",
          executionMode: "interactive",
          harnessMode: "restricted",
        });
      return Response.json({ configured: true, permission });
    }
    if (path === "/__a01/seed") {
      const runner = runnerId(input.runner),
        task = randomUlid(),
        run = randomUlid(),
        execution = randomUlid();
      const checkout = randomUlid(),
        snapshot = randomUlid(),
        launch = randomUlid(),
        claimKey = randomUlid(),
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
      // The committed C09 fixture supplies the closed execution shape; current fixture policy and inventory define its scope.
      const claim = JSON.parse(input.claim_template!) as LaunchClaimResult;
      const profile = (await db
        .prepare(
          "SELECT id FROM agent_profiles WHERE workspace_id=? AND provider='fake' AND model='synthetic'",
        )
        .get(workspace)) as { id: string };
      const workspacePolicy = await getWorkspacePolicy(db, workspace);
      const projectPolicy = await getProjectPolicy(db, workspace, FIX.projectA);
      const repository = (await db
        .prepare(
          "SELECT resource_version,content_hash FROM repository_configs WHERE workspace_id=? AND project_id=?",
        )
        .get(workspace, FIX.projectA)) as { resource_version: number; content_hash: string };
      claim.assignment = {
        schema_version: 1,
        workspace_id: workspace,
        project_id: FIX.projectA,
        task_id: task,
        run_id: run,
        run_execution_id: execution,
        runner_id: runner,
        checkout_id: checkout,
        assignment_generation: 1,
        created_at: now,
      };
      Object.assign(claim.snapshot, {
        workspace_id: workspace,
        project_id: FIX.projectA,
        task_id: task,
        agent_profile_id: profile.id,
        physical_worktree_hash: physical,
        workspace_policy_version: workspacePolicy.resourceVersion,
        project_policy_version: projectPolicy.resourceVersion,
        repository_config_version: repository.resource_version,
        repository_config_hash: repository.content_hash,
        repository_identity_hash: hash("synthetic/a01"),
      });
      const canonical = canonicalLaunchJson(claim.snapshot),
        snapshotHash = hash(canonical);
      Object.assign(claim.specification, {
        launch_id: launch,
        run_id: run,
        run_execution_id: execution,
        task_id: task,
        runner_id: runner,
        checkout_id: checkout,
        agent_profile_id: profile.id,
        config_snapshot_id: snapshot,
        config_snapshot_hash: snapshotHash,
        expires_at: new Date(Date.parse(now) + 120_000).toISOString(),
      });
      claim.lease_expires_at = new Date(Date.parse(now) + 45_000).toISOString();
      if (!decodeWireDocument("launch-claim-result", Buffer.from(JSON.stringify(claim))).ok)
        return new Response("invalid synthetic claim", { status: 400 });
      await db
        .prepare(
          `INSERT INTO tasks (workspace_id,id,project_id,title,state,priority,next_owner_type,punchline,created_by_human_id,created_at) VALUES (?,?,?,'Synthetic private task','active','P2','unassigned','Synthetic private punchline',?,?)`,
        )
        .run(workspace, task, FIX.projectA, FIX.owner, now);
      await db
        .prepare(
          `INSERT INTO runs (workspace_id,id,project_id,task_id,requested_by_human_id,agent_profile_id,result_state,activity,created_at) VALUES (?,?,?,?,?,?,'open','unknown',?)`,
        )
        .run(workspace, run, FIX.projectA, task, FIX.owner, profile.id, now);
      await db
        .prepare(
          `INSERT INTO run_configuration_snapshots (workspace_id,id,project_id,run_id,workspace_policy_version,project_policy_version,repository_config_version,agent_profile_id,agent_profile_version,canonical_json,content_hash,created_at) VALUES (?,?,?,?,?,?,?, ?,1,?,?,?)`,
        )
        .run(
          workspace,
          snapshot,
          FIX.projectA,
          run,
          workspacePolicy.resourceVersion,
          projectPolicy.resourceVersion,
          repository.resource_version,
          profile.id,
          canonical,
          snapshotHash,
          now,
        );
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
          `INSERT INTO launch_commands (workspace_id,id,execution_id,assignment_generation,run_id,requesting_human_id,idempotency_key_hash,request_hash,state,snapshot_id,created_at,expires_at,final_authorized_at,claim_key_hash) VALUES (?,?,?,1,?,?,?,?,'started',?,?,?,?,?)`,
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
          claim.specification.expires_at,
          now,
          hash(claimKey).slice(7),
        );
      await db
        .prepare(
          `INSERT INTO checkout_leases (workspace_id,runner_id,physical_worktree_hash,execution_id,assignment_generation,fencing_generation,state,expires_at) VALUES (?,?,?,?,1,1,'live',?)`,
        )
        .run(workspace, runner, physical, execution, claim.lease_expires_at);
      for (const [index, audience] of ["agent", "human", "both"].entries()) {
        const body = `Synthetic ${audience} context`;
        await db
          .prepare(
            `INSERT INTO task_context_items (workspace_id,id,task_id,kind,audience,body,version,content_hash,created_at) VALUES (?,?,?,'brief',?,?,?,?,?)`,
          )
          .run(workspace, randomUlid(), task, audience, body, index + 1, hash(body), now);
      }
      const inventory = {
        schema_version: 1,
        workspace_id: workspace,
        runner_id: runner,
        revision: Date.now(),
        checkouts: [
          {
            schema_version: 1,
            checkout_id: checkout,
            workspace_id: workspace,
            runner_id: runner,
            project_id: FIX.projectA,
            label: "Synthetic native checkout",
            repository_identity: "synthetic/a01",
            workspace_subpath: ".",
            physical_worktree_hash: physical,
            repository_config_hash: repository.content_hash,
            is_default: true,
            dirty: false,
            status: "validated",
            validated_at: now,
          },
        ],
        providers: [
          {
            provider: "fake",
            version: claim.snapshot.provider_version,
            manifest_id: claim.snapshot.provider_manifest_id,
            capabilities: claim.snapshot.execution_config.required_capabilities,
            status: "healthy",
            observed_at: now,
            expires_at: new Date(Date.parse(now) + 30_000).toISOString(),
          },
        ],
      };
      if (!decodeWireDocument("runner-inventory", Buffer.from(JSON.stringify(inventory))).ok)
        return new Response("invalid synthetic inventory", { status: 400 });
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
        claim,
        claim_key: claimKey,
        inventory,
      });
    }
    const execution = runnerId(input.execution);
    const row = (await db
      .prepare(
        `SELECT run_id,task_id,runner_id FROM execution_assignments WHERE workspace_id = ? AND execution_id = ?`,
      )
      .get(workspace, execution)) as { run_id: string; task_id: string; runner_id: string };
    if (!row) return new Response(null, { status: 404 });
    if (path === "/__a02/attention-observe") {
      const attention = await db
        .prepare("SELECT * FROM attention_requests WHERE workspace_id=? AND run_id=? ORDER BY id")
        .all(workspace, row.run_id);
      const observations = await db
        .prepare(
          `SELECT observation.attention_id,observation.observed_kind,observation.actor_type,observation.actor_id
           FROM attention_observations observation JOIN attention_requests attention
             ON attention.workspace_id=observation.workspace_id AND attention.id=observation.attention_id
           WHERE attention.workspace_id=? AND attention.run_id=? ORDER BY observation.observation_id`,
        )
        .all(workspace, row.run_id);
      const receipts = await db
        .prepare(
          `SELECT payload_json FROM audit_events WHERE workspace_id=? AND action LIKE 'attention.%'
           UNION ALL SELECT payload_json FROM semantic_events WHERE workspace_id=? AND kind LIKE 'attention.%'
           UNION ALL SELECT payload_json FROM outbox_records WHERE workspace_id=? AND kind LIKE 'attention.%'`,
        )
        .all(workspace, workspace, workspace);
      const clock = (await db
        .prepare(
          `SELECT inventory.revision,inventory.received_at,connection.last_seen_at,
             json_extract(inventory.inventory_json,'$.providers[0].provider') AS provider,
             json_extract(inventory.inventory_json,'$.providers[0].version') AS provider_version,
             json_extract(inventory.inventory_json,'$.providers[0].manifest_id') AS provider_manifest_id,
             json_extract(inventory.inventory_json,'$.providers[0].observed_at') AS provider_observed_at,
             json_extract(inventory.inventory_json,'$.providers[0].expires_at') AS provider_expires_at
           FROM runner_inventories inventory LEFT JOIN runner_connections connection
             ON connection.workspace_id=inventory.workspace_id AND connection.runner_id=inventory.runner_id
           WHERE inventory.workspace_id=? AND inventory.runner_id=?`,
        )
        .get(workspace, row.runner_id)) as Record<string, unknown> | undefined;
      return Response.json({ attention, observations, receipts, clock: { now, ...clock } });
    }
    if (path === "/__a01/pin") {
      const finalIdentity = canonicalLaunchJson(JSON.parse(input.final_identity!));
      await db
        .prepare(
          "UPDATE launch_commands SET final_identity_json=? WHERE workspace_id=? AND execution_id=?",
        )
        .run(finalIdentity, workspace, execution);
      return Response.json({ pinned: true });
    }
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
      else if (input.kind === "lease_replaced") {
        const replacement = (await db
          .prepare(
            `SELECT execution_id,assignment_generation FROM execution_assignments
             WHERE workspace_id=? AND runner_id=? AND execution_id!=? ORDER BY created_at LIMIT 1`,
          )
          .get(workspace, row.runner_id, execution)) as
          { execution_id: string; assignment_generation: number } | undefined;
        if (!replacement) return new Response(null, { status: 400 });
        await db
          .prepare(
            `UPDATE checkout_leases SET execution_id=?,assignment_generation=?,fencing_generation=fencing_generation+1
             WHERE workspace_id=? AND execution_id=?`,
          )
          .run(replacement.execution_id, replacement.assignment_generation, workspace, execution);
      } else if (input.kind === "result")
        await db
          .prepare(`UPDATE runs SET result_state = 'accepted' WHERE workspace_id = ? AND id = ?`)
          .run(workspace, row.run_id);
      else if (input.kind === "end")
        await db
          .prepare(
            `UPDATE run_executions SET state = 'ended', end_reason = 'process_exit', ended_at = ? WHERE workspace_id = ? AND id = ?`,
          )
          .run(now, workspace, execution);
      else if (input.kind === "session")
        await db
          .prepare(
            "UPDATE provider_sessions SET state='ended', ended_at=? WHERE workspace_id=? AND run_id=?",
          )
          .run(now, workspace, row.run_id);
      else if (input.kind === "root_allow" || input.kind === "root_deny") {
        const allowed = input.kind === "root_allow" ? 1 : 0;
        for (const table of ["workspace_policies", "project_policies", "repository_configs"])
          await db
            .prepare(`UPDATE ${table} SET allow_agent_root_propose=? WHERE workspace_id=?`)
            .run(allowed, workspace);
      } else return new Response(null, { status: 400 });
      return Response.json({ changed: true });
    }
    if (path === "/__a01/observe") {
      const lease = await db
        .prepare(
          "SELECT execution_id,fencing_generation,state,expires_at,observation_sequence,observed_at,identity_json FROM checkout_leases WHERE workspace_id=? AND execution_id=?",
        )
        .get(workspace, execution);
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
          `SELECT id,title,punchline,state,priority,next_owner_type,next_owner_id,next_action_reason,due_at,created_by_human_id,created_by_delegation_id,resource_version FROM tasks WHERE workspace_id = ? AND id = ?`,
        )
        .get(workspace, row.task_id);
      const commentCount = (await db
        .prepare(`SELECT count(*) AS count FROM comments WHERE workspace_id = ? AND task_id = ?`)
        .get(workspace, row.task_id)) as { count: number };
      const taskCount = (await db
        .prepare(`SELECT count(*) AS count FROM tasks WHERE workspace_id = ?`)
        .get(workspace)) as { count: number };
      const bindings = await db
        .prepare("SELECT * FROM execution_session_bindings WHERE workspace_id=? AND execution_id=?")
        .all(workspace, execution);
      const comments = await db
        .prepare("SELECT * FROM comments WHERE workspace_id=? AND task_id=? ORDER BY id")
        .all(workspace, row.task_id);
      const effects = await db
        .prepare(
          "SELECT * FROM agent_work_effects WHERE workspace_id=? AND execution_id=? ORDER BY operation_key",
        )
        .all(workspace, execution);
      const receipts = await db
        .prepare(
          "SELECT action,payload_json FROM audit_events WHERE workspace_id=? AND action IN ('agent_run.session_bind','agent_run.comment','agent_run.update','agent_run.progress','agent_run.proposal')",
        )
        .all(workspace);
      const targets = await db
        .prepare(
          `SELECT task.id,task.parent_task_id,task.state,task.priority,task.title,task.punchline,task.created_by_human_id,task.created_by_delegation_id,task.resource_version
         FROM agent_work_effects effect JOIN tasks task ON task.workspace_id=effect.workspace_id AND task.id=effect.target_task_id
         WHERE effect.workspace_id=? AND effect.execution_id=? AND effect.kind='task.propose' ORDER BY task.id`,
        )
        .all(workspace, execution);
      return Response.json({
        lease,
        deliveries,
        sessions,
        bindings,
        comments,
        effects,
        receipts,
        targets,
        business: { task, comments: commentCount.count, tasks: taskCount.count },
      });
    }
    return new Response(null, { status: 404 });
  },
};

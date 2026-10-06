// ABOUTME: Proves independent result policy proof binding and immutable permission versions.
// ABOUTME: Exercises complete V3 targets, explicit repository settings and current cache authority.

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIX, authorizeSyntheticPolicyUpdate } from "../src/fixtures.js";
import { WorkspaceHub, type HubCommand } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import {
  getWorkspacePolicy,
  getProjectPolicy,
  normalizeRepositoryConfig,
  policyUpdateTarget,
  repositoryConfigPolicyTarget,
  reportRepositoryConfigCommand,
  updateWorkspacePolicyCommand,
  updateProjectPolicyCommand,
  type PolicySettings,
} from "../src/projects.js";
import { issueStepUpProof } from "../src/step-up.js";
import { openDomainDb } from "./helpers.js";
import { resultStagedD1 } from "./result-fixture.js";

const NOW = "2026-10-06T00:00:00.000Z";
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => vi.useRealTimers());
const resultPermission = { allow_submit_result: true, max_pending_age_seconds: 300 };
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
async function fixture() {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db);
  const execute = <I, R>(command: HubCommand<I, R>, input: I, key = randomUlid()) =>
    hub.execute(command, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      idempotencyKey: key,
      input,
    });
  const workspace = await getWorkspacePolicy(db, FIX.workspace);
  const settings: PolicySettings = { ...workspace, offlineAgentResults: resultPermission };
  for (const project of [false, true]) {
    const input = await authorizeSyntheticPolicyUpdate(
      db,
      { workspaceId: FIX.workspace, humanId: FIX.owner },
      { ...settings, expectedVersion: 1, ...(project ? { projectId: FIX.projectA } : {}) },
    );
    const outcome = await execute(
      project ? updateProjectPolicyCommand : updateWorkspacePolicyCommand,
      input,
    );
    expect(outcome).toMatchObject({ ok: true });
  }
  return { db, hub, execute, settings };
}
describe("result policy authority", () => {
  it("rejects a proof whose V3 result permission or legacy settings changed", async () => {
    const f = await fixture(),
      current = await getWorkspacePolicy(f.db, FIX.workspace);
    const input = await authorizeSyntheticPolicyUpdate(
      f.db,
      { workspaceId: FIX.workspace, humanId: FIX.owner },
      {
        ...current,
        expectedVersion: current.resourceVersion,
        offlineAgentResults: { allow_submit_result: true, max_pending_age_seconds: 30 },
      },
    );
    expect(
      await f.execute(updateWorkspacePolicyCommand, {
        ...input,
        offlineAgentResults: { allow_submit_result: true, max_pending_age_seconds: 31 },
      }),
    ).toMatchObject({ ok: false, error: { code: "step_up_mismatch" } });
    expect(
      await f.execute(updateWorkspacePolicyCommand, {
        ...input,
        allowPassToAgent: !input.allowPassToAgent,
      }),
    ).toMatchObject({ ok: false, error: { code: "step_up_mismatch" } });
    expect(
      await f.db
        .prepare("SELECT consumed_at FROM passkey_step_up_proofs WHERE proof_id=?")
        .get(input.stepUpProofId),
    ).toEqual({ consumed_at: null });
  });
  it.each([
    /INSERT INTO workspace_policy_versions/,
    /INSERT INTO outbox_records/,
    /INSERT INTO idempotency_records/,
  ])("rolls back result permission and proof after late D1 failure %s", async (pattern) => {
    const f = await fixture(),
      current = await getWorkspacePolicy(f.db, FIX.workspace);
    const input = await authorizeSyntheticPolicyUpdate(
      f.db,
      { workspaceId: FIX.workspace, humanId: FIX.owner },
      {
        ...current,
        expectedVersion: current.resourceVersion,
        offlineAgentResults: { allow_submit_result: true, max_pending_age_seconds: 1 },
      },
    );
    const adapter = resultStagedD1(f.db),
      hub = new WorkspaceHub(adapter.db);
    const tables = [
      "workspace_policies",
      "workspace_policy_versions",
      "passkey_step_up_proofs",
      "idempotency_records",
      "audit_events",
      "semantic_events",
      "outbox_records",
      "workspace_cursors",
    ];
    const rows = () =>
      Promise.all(
        tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
      );
    const before = await rows();
    adapter.fail(pattern);
    expect(
      await hub.execute(updateWorkspacePolicyCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        input,
      }),
    ).toMatchObject({ ok: false, error: { code: "command_failed" } });
    expect(await rows()).toEqual(before);
  });
  it("binds both complete permission families and legacy flags in V3 targets", async () => {
    const f = await fixture();
    const target = (settings: PolicySettings) =>
      policyUpdateTarget(FIX.workspace, "workspace.policy.update", undefined, 2, settings);
    expect(target(f.settings)).not.toBe(
      target({
        ...f.settings,
        offlineAgentResults: { allow_submit_result: false, max_pending_age_seconds: 0 },
      }),
    );
    expect(target(f.settings)).not.toBe(
      target({
        ...f.settings,
        offlineAgentWork: { allowed_tools: ["bfb_add_comment"], max_pending_age_seconds: 1 },
      }),
    );
    expect(target(f.settings)).not.toBe(
      target({ ...f.settings, allowRunOverrides: !f.settings.allowRunOverrides }),
    );
    expect(() => target({ ...f.settings, offlineAgentResults: undefined as never })).toThrow(
      /complete object/,
    );
    expect(() => target({ ...f.settings, offlineAgentWork: undefined as never })).toThrow(
      /complete object/,
    );
  });
  it.each(["offline_agent_work", "offline_agent_results"])(
    "requires proof for explicit denied %s and leaves omission denied",
    async (field) => {
      const f = await fixture();
      const document =
        field === "offline_agent_work"
          ? { offline_agent_work: { allowed_tools: [], max_pending_age_seconds: 0 } }
          : { offline_agent_results: { allow_submit_result: false, max_pending_age_seconds: 0 } };
      const normalized = normalizeRepositoryConfig(document, f.settings),
        contentHash = hash(normalized.canonical);
      const input = { projectId: FIX.projectA, expectedVersion: 1, document, contentHash };
      expect(await f.execute(reportRepositoryConfigCommand, input)).toMatchObject({
        ok: false,
        error: { code: "step_up_invalid" },
      });
      const stepUpProofId = await issueStepUpProof(
        f.db,
        FIX.owner,
        {
          action: "repository.config.report",
          workspaceId: FIX.workspace,
          projectId: FIX.projectA,
          targetId: repositoryConfigPolicyTarget(
            FIX.workspace,
            FIX.projectA,
            1,
            contentHash,
            normalized.settings,
          ),
          scopes: [],
          authorizationEpoch: 1,
          expiresAt: "2026-10-06T00:01:00.000Z",
        },
        NOW,
      );
      const key = randomUlid();
      expect(
        await f.execute(reportRepositoryConfigCommand, { ...input, stepUpProofId }, key),
      ).toMatchObject({ ok: true });
      expect(
        await f.execute(reportRepositoryConfigCommand, { ...input, stepUpProofId }, key),
      ).toMatchObject({ ok: true, replayed: true });
      expect(normalized.settings.offlineAgentResults).toEqual({
        allow_submit_result: false,
        max_pending_age_seconds: 0,
      });
    },
  );
  it("enables only results atomically across current and immutable policy rows", async () => {
    const f = await fixture();
    const document = { offline_agent_results: resultPermission };
    const normalized = normalizeRepositoryConfig(document, f.settings),
      contentHash = hash(normalized.canonical);
    const stepUpProofId = await issueStepUpProof(
      f.db,
      FIX.owner,
      {
        action: "repository.config.report",
        workspaceId: FIX.workspace,
        projectId: FIX.projectA,
        targetId: repositoryConfigPolicyTarget(
          FIX.workspace,
          FIX.projectA,
          1,
          contentHash,
          normalized.settings,
        ),
        scopes: [],
        authorizationEpoch: 1,
        expiresAt: "2026-10-06T00:01:00.000Z",
      },
      NOW,
    );
    expect(
      await f.execute(reportRepositoryConfigCommand, {
        projectId: FIX.projectA,
        expectedVersion: 1,
        document,
        contentHash,
        stepUpProofId,
      }),
    ).toMatchObject({ ok: true });
    for (const table of [
      "workspace_policies",
      "workspace_policy_versions",
      "project_policies",
      "project_policy_versions",
      "repository_configs",
      "repository_config_versions",
    ]) {
      const row = await f.db
        .prepare(
          `SELECT offline_result_allow_submit AS allow,offline_result_max_pending_age_seconds AS age,offline_agent_tools_json AS tools FROM ${table} WHERE workspace_id=? ${table.startsWith("workspace") ? "" : "AND project_id=?"} ORDER BY ${table.endsWith("versions") ? "version" : "resource_version"} DESC LIMIT 1`,
        )
        .get(...(table.startsWith("workspace") ? [FIX.workspace] : [FIX.workspace, FIX.projectA]));
      expect(row).toEqual({ allow: 1, age: 300, tools: "[]" });
    }
  });
  it("rejects project widening and changed-body reuse; cached success still checks the owner", async () => {
    const f = await fixture(),
      current = await getWorkspacePolicy(f.db, FIX.workspace);
    const input = await authorizeSyntheticPolicyUpdate(
      f.db,
      { workspaceId: FIX.workspace, humanId: FIX.owner },
      {
        ...current,
        expectedVersion: current.resourceVersion,
        offlineAgentResults: { allow_submit_result: false, max_pending_age_seconds: 0 },
      },
    );
    const key = randomUlid();
    expect(await f.execute(updateWorkspacePolicyCommand, input, key)).toMatchObject({ ok: true });
    expect(
      await f.execute(
        updateWorkspacePolicyCommand,
        { ...input, allowRunOverrides: !input.allowRunOverrides },
        key,
      ),
    ).toMatchObject({ ok: false, error: { code: "request_rejected" } });
    const project = await getProjectPolicy(f.db, FIX.workspace, FIX.projectA);
    const wider = await authorizeSyntheticPolicyUpdate(
      f.db,
      { workspaceId: FIX.workspace, humanId: FIX.owner },
      { ...project, projectId: FIX.projectA, expectedVersion: project.resourceVersion },
    );
    expect(await f.execute(updateProjectPolicyCommand, wider)).toMatchObject({
      ok: false,
      error: { code: "policy_widening" },
    });
    await f.db
      .prepare("UPDATE workspace_members SET authorization_epoch=2 WHERE human_id=?")
      .run(FIX.owner);
    expect(await f.execute(updateWorkspacePolicyCommand, input, key)).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
  });
});

// ABOUTME: Runs the local checkout policy fixtures through canonical cloud domain commands.
// ABOUTME: Proves Go and TypeScript agree on restriction hashes, inherited settings and widening rejection.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  FIX,
  reportRepositoryConfigCommand,
  updateProjectPolicyCommand,
  updateWorkspacePolicyCommand,
  workspaceHub,
  type HubCommand,
  type Provider,
} from "../src/index.js";
import { openDomainDb } from "./helpers.js";

type FixturePolicy = {
  allowed_providers: Provider[];
  allow_agent_root_propose: boolean;
  allow_pass_to_agent: boolean;
  allow_run_overrides: boolean;
};

const contract = JSON.parse(
  readFileSync(new URL("../../../protocol/fixtures/checkout-policy.json", import.meta.url), "utf8"),
) as {
  fixtures: {
    name: string;
    document: unknown;
    canonical: string;
    hash: string;
    parent: FixturePolicy;
    effective?: FixturePolicy;
    error?: string;
  }[];
};

function settings(policy: FixturePolicy) {
  return {
    allowedProviders: policy.allowed_providers,
    allowAgentRootPropose: policy.allow_agent_root_propose,
    allowPassToAgent: policy.allow_pass_to_agent,
    allowRunOverrides: policy.allow_run_overrides,
  };
}

describe("shared local and cloud checkout policy contract", () => {
  it.each(contract.fixtures)("$name", async (fixture) => {
    const db = await openDomainDb();
    const execute = <I, R>(command: HubCommand<I, R>, input: I) =>
      workspaceHub(db, FIX.workspace).execute(command, {
        workspaceId: FIX.workspace,
        idempotencyKey: `checkout-fixture-${fixture.name}-${command.name}`,
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        now: "2026-09-11T12:00:00Z",
        input,
      });
    expect(
      await execute(updateWorkspacePolicyCommand, {
        expectedVersion: 1,
        ...settings(fixture.parent),
      }),
    ).toMatchObject({ ok: true });
    expect(
      await execute(updateProjectPolicyCommand, {
        projectId: FIX.projectA,
        expectedVersion: 1,
        ...settings(fixture.parent),
      }),
    ).toMatchObject({ ok: true });
    const result = await execute(reportRepositoryConfigCommand, {
      projectId: FIX.projectA,
      expectedVersion: 1,
      document: fixture.document,
      contentHash: fixture.hash,
    });
    if (fixture.error) {
      expect(fixture.error).toBe("checkout_policy_widening");
      expect(result).toMatchObject({ ok: false, error: { code: "policy_widening" } });
      return;
    }
    expect(result).toMatchObject({
      ok: true,
      result: { version: 2, canonicalJson: fixture.canonical, contentHash: fixture.hash },
    });
    const persisted = (await db
      .prepare(
        `SELECT allowed_providers_json, allow_agent_root_propose,
         allow_pass_to_agent, allow_run_overrides FROM repository_configs
         WHERE workspace_id = ? AND project_id = ?`,
      )
      .get(FIX.workspace, FIX.projectA)) as {
      allowed_providers_json: string;
      allow_agent_root_propose: number;
      allow_pass_to_agent: number;
      allow_run_overrides: number;
    };
    expect({
      allowed_providers: JSON.parse(persisted.allowed_providers_json),
      allow_agent_root_propose: Boolean(persisted.allow_agent_root_propose),
      allow_pass_to_agent: Boolean(persisted.allow_pass_to_agent),
      allow_run_overrides: Boolean(persisted.allow_run_overrides),
    }).toEqual(fixture.effective);
  });
});

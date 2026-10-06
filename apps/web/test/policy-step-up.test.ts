// ABOUTME: Pins browser and domain parity for versioned offline-policy passkey targets.
// ABOUTME: Checks exact workspace, version, capability and offline-permission binding without Node crypto in the browser.

import { FIX, policyUpdateTarget, type PolicySettings } from "@bfb/domain";
import { describe, expect, it } from "vitest";
import { responseError, workspacePolicyStepUpTarget } from "../src/settings.js";

describe("policy response errors", () => {
  it("renders Hub denial messages rather than coercing an object to text", async () => {
    expect(
      await responseError(
        Response.json(
          { ok: false, error: { code: "permission_denied", message: "Step-up proof expired" } },
          { status: 403 },
        ),
      ),
    ).toBe("Step-up proof expired");
    expect(await responseError(Response.json({ message: "Invalid policy" }))).toBe(
      "Invalid policy",
    );
    expect(await responseError(Response.json({ error: "Invalid request" }))).toBe(
      "Invalid request",
    );
  });

  it("falls back to the status for malformed or non-JSON errors", async () => {
    for (const body of [null, [], "denied", { error: {} }, { error: { message: 3 } }])
      expect(await responseError(Response.json(body, { status: 503 }))).toBe(
        "Request failed (503)",
      );
    expect(await responseError(new Response("unavailable", { status: 503 }))).toBe(
      "Request failed (503)",
    );
  });
});

describe("workspace policy passkey target", () => {
  it("matches canonical server targets for denied and explicitly enabled ceilings", async () => {
    for (const offline of [
      {
        allowed_tools: [] as PolicySettings["offlineAgentWork"]["allowed_tools"],
        max_pending_age_seconds: 0,
      },
      {
        allowed_tools: [
          "bfb_update_task",
          "bfb_add_comment",
          "bfb_update_task",
        ] as PolicySettings["offlineAgentWork"]["allowed_tools"],
        max_pending_age_seconds: 300,
      },
    ]) {
      for (const results of [
        { allow_submit_result: false, max_pending_age_seconds: 0 },
        { allow_submit_result: true, max_pending_age_seconds: 1 },
        { allow_submit_result: true, max_pending_age_seconds: 300 },
      ]) {
        const settings: PolicySettings = {
          allowedProviders: ["codex", "claude", "codex"],
          allowAgentRootPropose: false,
          allowPassToAgent: true,
          allowRunOverrides: false,
          offlineAgentWork: offline,
          offlineAgentResults: results,
        };
        expect(
          await workspacePolicyStepUpTarget(FIX.workspace, 7, {
            allowed_providers: settings.allowedProviders,
            allow_agent_root_propose: settings.allowAgentRootPropose,
            allow_pass_to_agent: settings.allowPassToAgent,
            allow_run_overrides: settings.allowRunOverrides,
            offline_agent_work: offline,
            offline_agent_results: settings.offlineAgentResults,
          }),
        ).toBe(
          policyUpdateTarget(FIX.workspace, "workspace.policy.update", undefined, 7, settings),
        );
      }
    }
  });

  it("changes when workspace, expected version, tool set or pending age changes", async () => {
    const settings = {
      allowed_providers: ["codex"],
      allow_agent_root_propose: false,
      allow_pass_to_agent: true,
      allow_run_overrides: false,
      offline_agent_work: { allowed_tools: ["bfb_add_comment"], max_pending_age_seconds: 30 },
      offline_agent_results: { allow_submit_result: true, max_pending_age_seconds: 30 },
    };
    const base = await workspacePolicyStepUpTarget(FIX.workspace, 1, settings);
    for (const changed of [
      workspacePolicyStepUpTarget(FIX.projectA, 1, settings),
      workspacePolicyStepUpTarget(FIX.workspace, 2, settings),
      workspacePolicyStepUpTarget(FIX.workspace, 1, {
        ...settings,
        allow_agent_root_propose: true,
      }),
      workspacePolicyStepUpTarget(FIX.workspace, 1, {
        ...settings,
        offline_agent_work: { allowed_tools: ["bfb_report_progress"], max_pending_age_seconds: 30 },
      }),
      workspacePolicyStepUpTarget(FIX.workspace, 1, {
        ...settings,
        offline_agent_work: { allowed_tools: ["bfb_add_comment"], max_pending_age_seconds: 31 },
      }),
      workspacePolicyStepUpTarget(FIX.workspace, 1, {
        ...settings,
        offline_agent_results: { allow_submit_result: false, max_pending_age_seconds: 0 },
      }),
      workspacePolicyStepUpTarget(FIX.workspace, 1, {
        ...settings,
        offline_agent_results: { allow_submit_result: true, max_pending_age_seconds: 31 },
      }),
    ])
      expect(await changed).not.toBe(base);
  });
});

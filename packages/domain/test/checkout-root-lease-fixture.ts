// ABOUTME: Builds synthetic Claude assignments for separately versioned root occupancy tests.
// ABOUTME: Keeps provider selection, immutable snapshots and final authorization on existing domain commands.

import type { CheckoutRootLeaseObservation, LaunchFinalRequest } from "@bfb/protocol";

import { createAgentProfileCommand } from "../src/projects.js";
import { LAUNCH_NOW, launchFixture, success } from "./launch-fixture.js";

export async function configureRootLaunchFixture(f: Awaited<ReturnType<typeof launchFixture>>) {
  const profile = success(
    await f.human(createAgentProfileCommand, {
      name: "Synthetic root-supervised Claude",
      provider: "claude",
      model: "synthetic",
      executionMode: "interactive",
      harnessMode: "standard",
    }),
  );
  await f.refresh(LAUNCH_NOW, {
    providers: [
      {
        ...f.inventory().providers[0]!,
        provider: "claude",
        version: "2.1.291",
        capabilities: [
          "launch.interactive",
          "filesystem.workspace_write",
          "approval.on_request",
          "context.session_start",
          "prompt.initial_constant",
          "hooks.session_start",
          "mcp.stdio",
          "control.interrupt",
          "control.terminate",
          "session.resume",
        ],
      },
    ],
  });
  f.start.agent_profile_id = profile.id;
  f.start.agent_profile_version = profile.resource_version;
}

export function rootLeaseObservation(final: LaunchFinalRequest): CheckoutRootLeaseObservation {
  return {
    schema_version: 2,
    run_execution_id: final.run_execution_id,
    assignment_generation: final.assignment_generation,
    fencing_generation: final.fencing_generation,
    sequence: 1,
    observed_at: LAUNCH_NOW,
    operation: "renew",
    supervisor: final.supervisor,
    local_lock_id: final.local_lock_id,
    owned_group_id: 1235,
    owned_group_start_identity: "123456:2000",
    supervisor_state: "verified",
    group_state: "live",
    lock_state: "held",
    descendants_state: "unproven",
    recovery_local: false,
    supervision_mode: "root",
    family_coverage: "unproven",
  };
}

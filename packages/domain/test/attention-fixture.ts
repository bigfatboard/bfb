// ABOUTME: Binds claimed synthetic runs for attention tests through real domain transitions.
// ABOUTME: Reuses final authorization, lease observation and canonical session creation without bypasses.

import { prepareSyntheticAttentionClaim } from "../src/attention-fixture.js";
import type { LaunchClaimResult } from "@bfb/protocol";
import { resolveCommand } from "../src/command-catalog.js";
import { randomUlid } from "../src/ids.js";
import { runnerHash } from "../src/runner-crypto.js";
import { createTaskCommand } from "../src/work-commands.js";
import { startLaunchCommand, claimLaunchCommand } from "../src/launches.js";
import { FIX } from "../src/fixtures.js";
import { launchFixture, LAUNCH_NOW, success } from "./launch-fixture.js";

type Fixture = Awaited<ReturnType<typeof launchFixture>>;

export async function prepareAttentionBinding(
  f: Fixture,
  claimed: Awaited<ReturnType<Fixture["claim"]>>,
) {
  return prepareAttentionClaim(f, claimed.claimed);
}

export async function prepareAttentionClaim(f: Fixture, claimed: LaunchClaimResult) {
  return prepareSyntheticAttentionClaim(
    async (name, input) => {
      const command = resolveCommand(name);
      if (!command) throw new Error(`missing fixture command ${name}`);
      return success(await f.native(command, input));
    },
    f.principal,
    claimed,
    LAUNCH_NOW,
  );
}

/** Creates an independent valid same-project run, not a changed record's claimed scope. */
export async function claimAnotherAttentionRun(f: Fixture) {
  const task = success(
    await f.human(createTaskCommand, {
      projectId: FIX.projectA,
      title: "Synthetic separate attention run",
      priority: "P2",
    }),
  );
  const checkout = {
    ...f.inventory().checkouts[0]!,
    checkout_id: randomUlid(),
    physical_worktree_hash: `sha256:${runnerHash(randomUlid())}`,
    is_default: false,
  };
  await f.refresh(LAUNCH_NOW, { checkouts: [...f.inventory().checkouts, checkout] });
  const launch = success(
    await f.human(startLaunchCommand, {
      ...f.start,
      idempotency_key: randomUlid(),
      task_id: task.id,
      expected_task_version: 1,
      checkout_id: checkout.checkout_id,
    }),
  );
  const claimed = success(
    await f.native(claimLaunchCommand, {
      principal: f.principal,
      claim: {
        schema_version: 1,
        launch_id: launch.launch_id,
        runner_id: f.runner,
        idempotency_key: randomUlid(),
        claimed_at: LAUNCH_NOW,
      },
    }),
  );
  if (claimed.state !== "claimed") throw new Error("separate attention run was not claimed");
  return prepareAttentionClaim(f, claimed.claim);
}

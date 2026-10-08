// ABOUTME: Issues verifier-only cloud wake hints bound to one existing launch and device key.
// ABOUTME: Redemption consumes a hint once and never creates or claims a launch assignment.

import { randomBytes } from "node:crypto";

import type { HubCommand } from "./hub.js";
import {
  guardLaunchMutation,
  launchHuman,
  launchRunner,
  readLaunch,
  reauthorizeLaunch,
} from "./launch-state.js";
import {
  rejectRunnerRequest,
  runnerDigest,
  runnerHash,
  runnerId,
  runnerObject,
} from "./runner-crypto.js";
import type { RunnerPrincipal } from "./runners.js";

/** Uniform 128-bit identifier in the existing native ULID grammar; no timestamp reduces entropy. */
export function createCloudWakeIdentifier(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let number = BigInt(`0x${randomBytes(16).toString("hex")}`),
    result = "";
  for (let index = 0; index < 26; index++) {
    result = alphabet[Number(number & 31n)] + result;
    number >>= 5n;
  }
  return result;
}

/** Call only at the transport boundary; the original value must never enter a hub envelope. */
export function cloudWakeVerifier(identifier: unknown): string {
  return runnerHash(`bfb-cloud-wake/1\n${runnerId(identifier)}`);
}

export const issueLaunchWakeCommand: HubCommand<
  { launchId: string; verifier: string },
  {
    workspace_id: string;
    runner_id: string;
    requesting_human_id: string;
    launch_id: string;
    expires_at: string;
  }
> = {
  name: "launch.wake.issue",
  replay: "reject",
  auditInput: (input) => ({ launchId: input.launchId }),
  async run(input, ctx) {
    runnerObject(input, ["launchId", "verifier"]);
    const human = await launchHuman(ctx),
      verifier = runnerDigest(input.verifier);
    const row = await readLaunch(ctx.db, ctx.workspaceId, runnerId(input.launchId));
    if (
      row.requesting_human_id !== human.humanId ||
      row.requesting_human_epoch !== human.authorizationEpoch ||
      row.cancelled_at ||
      (row.state !== "pending" && row.state !== "claimed") ||
      Date.parse(row.expires_at) <= Date.parse(ctx.now)
    )
      rejectRunnerRequest();
    await reauthorizeLaunch(ctx, row, false);
    await ctx.db
      .prepare(
        `INSERT INTO launch_wake_intents (workspace_id, verifier, launch_id, requesting_human_id, requesting_human_epoch,
      runner_id, runner_key_thumbprint, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        verifier,
        row.id,
        row.requesting_human_id,
        row.requesting_human_epoch,
        row.runner_id,
        row.runner_key_thumbprint,
        ctx.now,
        row.expires_at,
      );
    return {
      workspace_id: ctx.workspaceId,
      runner_id: row.runner_id,
      requesting_human_id: row.requesting_human_id,
      launch_id: row.id,
      expires_at: row.expires_at,
    };
  },
};

export const redeemLaunchWakeCommand: HubCommand<
  { principal: RunnerPrincipal; verifier: string },
  { launch_id: string; runner_id: string }
> = {
  name: "launch.wake.redeem",
  replay: "reject",
  auditInput: (input) => ({ runnerId: input.principal.runnerId }),
  async run(input, ctx) {
    runnerObject(input, ["principal", "verifier"]);
    const principal = await launchRunner(ctx, input.principal),
      verifier = runnerDigest(input.verifier);
    const intent = (await ctx.db
      .prepare(
        `SELECT launch_id, requesting_human_id, requesting_human_epoch, runner_id, runner_key_thumbprint, expires_at, consumed_at
      FROM launch_wake_intents WHERE workspace_id = ? AND verifier = ?`,
      )
      .get(ctx.workspaceId, verifier)) as
      | {
          launch_id: string;
          requesting_human_id: string;
          requesting_human_epoch: number;
          runner_id: string;
          runner_key_thumbprint: string;
          expires_at: string;
          consumed_at: string | null;
        }
      | undefined;
    if (
      !intent ||
      intent.runner_id !== principal.runnerId ||
      intent.runner_key_thumbprint !== principal.keyThumbprint ||
      intent.consumed_at ||
      Date.parse(intent.expires_at) <= Date.parse(ctx.now)
    )
      rejectRunnerRequest();
    const row = await readLaunch(ctx.db, ctx.workspaceId, intent.launch_id);
    if (
      row.requesting_human_id !== intent.requesting_human_id ||
      row.requesting_human_epoch !== intent.requesting_human_epoch ||
      row.runner_id !== intent.runner_id ||
      row.cancelled_at ||
      (row.state !== "pending" && row.state !== "claimed") ||
      Date.parse(row.expires_at) <= Date.parse(ctx.now)
    )
      rejectRunnerRequest();
    await reauthorizeLaunch(ctx, row, false);
    await guardLaunchMutation(
      ctx,
      `EXISTS (SELECT 1 FROM launch_wake_intents WHERE workspace_id = ? AND verifier = ? AND consumed_at IS NULL AND expires_at > ?)`,
      [ctx.workspaceId, verifier, ctx.now],
    );
    await ctx.db
      .prepare(
        `UPDATE launch_wake_intents SET consumed_at = ? WHERE workspace_id = ? AND verifier = ?`,
      )
      .run(ctx.now, ctx.workspaceId, verifier);
    return { launch_id: row.id, runner_id: row.runner_id };
  },
};

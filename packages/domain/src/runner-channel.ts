// ABOUTME: Owns current-authority runner observations and bounded durable delivery references.
// ABOUTME: Connection state and inventory stay distinct from business commands, process activity and event dispositions.

import { assertUtcTimestamp, type SqlDatabase } from "@bfb/db";
import { decodeWireDocument } from "@bfb/protocol";
import type { RunnerInventory } from "@bfb/protocol";

import type { HubCommand, HubContext } from "./hub.js";
import { runnerId, rejectRunnerRequest, runnerObject } from "./runner-crypto.js";
import { assertCurrentRunnerPrincipal, type RunnerPrincipal } from "./runners.js";

export const RUNNER_INVENTORY_LIMIT = 49_152;

async function current(
  input: { principal: RunnerPrincipal },
  ctx: HubContext,
): Promise<RunnerPrincipal> {
  if (
    ctx.actorRunnerId !== input.principal.runnerId ||
    ctx.workspaceId !== input.principal.workspaceId ||
    ctx.authorizationEpoch !== input.principal.authorizationEpoch ||
    ctx.actorHumanId ||
    ctx.actorDelegationId ||
    ctx.actorSystemId
  )
    rejectRunnerRequest();
  return assertCurrentRunnerPrincipal(ctx.db, input.principal, ctx.now);
}

export const touchRunnerConnectionCommand: HubCommand<
  { principal: RunnerPrincipal; connectionId: string; mode: "open" | "heartbeat" },
  { connection_id: string; last_seen_at: string }
> = {
  name: "runner.connection.touch",
  auditInput: (input) => ({
    runnerId: input.principal.runnerId,
    connectionId: input.connectionId,
    mode: input.mode,
  }),
  async run(input, ctx) {
    runnerObject(input, ["principal", "connectionId", "mode"]);
    const principal = await current(input, ctx);
    runnerId(input.connectionId);
    if (input.mode !== "open" && input.mode !== "heartbeat") rejectRunnerRequest();
    if (input.mode === "heartbeat") {
      const existing = (await ctx.db
        .prepare(
          `SELECT connection_id, token_epoch FROM runner_connections WHERE workspace_id = ? AND runner_id = ?`,
        )
        .get(ctx.workspaceId, principal.runnerId)) as
        { connection_id: string; token_epoch: number } | undefined;
      if (
        !existing ||
        existing.connection_id !== input.connectionId ||
        existing.token_epoch !== principal.tokenEpoch
      )
        rejectRunnerRequest();
    }
    await ctx.db
      .prepare(
        `INSERT INTO runner_connections (workspace_id, runner_id, connection_id, token_epoch, last_seen_at, auth_expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, runner_id) DO UPDATE SET connection_id = excluded.connection_id, token_epoch = excluded.token_epoch, last_seen_at = excluded.last_seen_at, auth_expires_at = excluded.auth_expires_at`,
      )
      .run(
        ctx.workspaceId,
        principal.runnerId,
        input.connectionId,
        principal.tokenEpoch,
        ctx.now,
        principal.authExpiresAt,
      );
    return { connection_id: input.connectionId, last_seen_at: ctx.now };
  },
};

export const replaceRunnerInventoryCommand: HubCommand<
  { principal: RunnerPrincipal; inventory: RunnerInventory },
  { revision: number }
> = {
  name: "runner.inventory.replace",
  auditInput: (input) => ({
    runnerId: input.principal.runnerId,
    revision: input.inventory.revision,
  }),
  async run(input, ctx) {
    runnerObject(input, ["principal", "inventory"]);
    const principal = await current(input, ctx);
    const serialized = JSON.stringify(input.inventory);
    const decoded = decodeWireDocument("runner-inventory", new TextEncoder().encode(serialized));
    if (!decoded.ok || new TextEncoder().encode(serialized).byteLength > RUNNER_INVENTORY_LIMIT)
      rejectRunnerRequest();
    const inventory = input.inventory;
    if (
      inventory.workspace_id !== ctx.workspaceId ||
      inventory.runner_id !== principal.runnerId ||
      new Set(inventory.checkouts.map((item) => item.checkout_id)).size !==
        inventory.checkouts.length ||
      new Set(inventory.providers.map((item) => item.provider)).size !== inventory.providers.length
    )
      rejectRunnerRequest();
    for (const checkout of inventory.checkouts) {
      if (
        checkout.workspace_id !== ctx.workspaceId ||
        checkout.runner_id !== principal.runnerId ||
        !principal.projectIds.includes(checkout.project_id)
      )
        rejectRunnerRequest();
    }
    for (const provider of inventory.providers) {
      const age = Date.parse(ctx.now) - Date.parse(provider.observed_at);
      const duration = Date.parse(provider.expires_at) - Date.parse(provider.observed_at);
      if (
        age < -5_000 ||
        age > 30_000 ||
        duration < 0 ||
        duration > 30_000 ||
        (provider.status !== "healthy" && provider.capabilities.length !== 0) ||
        (provider.status === "healthy" && (!provider.version || !provider.manifest_id))
      )
        rejectRunnerRequest();
    }
    const previous = (await ctx.db
      .prepare(
        `SELECT revision, inventory_json FROM runner_inventories WHERE workspace_id = ? AND runner_id = ?`,
      )
      .get(ctx.workspaceId, principal.runnerId)) as
      { revision: number; inventory_json: string } | undefined;
    if (previous && inventory.revision <= previous.revision) {
      if (inventory.revision === previous.revision && serialized === previous.inventory_json)
        return { revision: inventory.revision };
      rejectRunnerRequest();
    }
    await ctx.db
      .prepare(
        `INSERT INTO runner_inventories (workspace_id, runner_id, revision, inventory_json, received_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (workspace_id, runner_id) DO UPDATE SET revision = excluded.revision, inventory_json = excluded.inventory_json, received_at = excluded.received_at`,
      )
      .run(ctx.workspaceId, principal.runnerId, inventory.revision, serialized, ctx.now);
    return { revision: inventory.revision };
  },
};

export interface RunnerCommandReference {
  command_id: string;
  command_kind: "launch" | "run_control" | "discussion_turn";
  expires_at: string;
}

/** Called inside an already-authorized owning domain command; no public append endpoint exists. */
export async function appendRunnerCommandReference(
  ctx: HubContext,
  runner: string,
  project: string,
  reference: RunnerCommandReference,
): Promise<void> {
  runnerId(runner);
  runnerId(project);
  runnerId(reference.command_id);
  assertUtcTimestamp(reference.expires_at, "expires_at");
  if (!["launch", "run_control", "discussion_turn"].includes(reference.command_kind))
    rejectRunnerRequest();
  await ctx.db
    .prepare(
      `INSERT INTO runner_command_references (workspace_id, runner_id, command_id, command_kind, project_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ctx.workspaceId,
      runner,
      reference.command_id,
      reference.command_kind,
      project,
      ctx.now,
      reference.expires_at,
    );
}

/** C09/D02 resolve only after their durable terminal transition, never on socket acknowledgement. */
export async function resolveRunnerCommandReference(
  ctx: HubContext,
  runner: string,
  command: string,
): Promise<void> {
  runnerId(runner);
  runnerId(command);
  await ctx.db
    .prepare(
      `UPDATE runner_command_references SET resolved_at = ? WHERE workspace_id = ? AND runner_id = ? AND command_id = ? AND resolved_at IS NULL`,
    )
    .run(ctx.now, ctx.workspaceId, runner, command);
}

export async function pullRunnerCommands(
  db: SqlDatabase,
  principal: RunnerPrincipal,
  now: string,
  after?: string,
): Promise<{
  schema_version: 1;
  workspace_id: string;
  runner_id: string;
  commands: RunnerCommandReference[];
  more: boolean;
  next_command_id?: string;
}> {
  const active = await assertCurrentRunnerPrincipal(db, principal, now);
  if (after !== undefined) runnerId(after);
  const rows = active.projectIds.length
    ? ((await db
        .prepare(
          `SELECT command_id, command_kind, expires_at FROM runner_command_references WHERE workspace_id = ? AND runner_id = ? AND resolved_at IS NULL AND command_id > ? AND project_id IN (${active.projectIds.map(() => "?").join(",")}) ORDER BY command_id LIMIT 26`,
        )
        .all(
          active.workspaceId,
          active.runnerId,
          after ?? "",
          ...active.projectIds,
        )) as RunnerCommandReference[])
    : [];
  const page = rows.slice(0, 25);
  const result = {
    schema_version: 1 as const,
    workspace_id: active.workspaceId,
    runner_id: active.runnerId,
    commands: page,
    more: rows.length > 25,
  };
  return result.more ? { ...result, next_command_id: page.at(-1)!.command_id } : result;
}

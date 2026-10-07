// ABOUTME: Projects public command receipts without exposing the internal workspace position.
// ABOUTME: Preserves authorized business results and errors while internal transports keep complete Hub outcomes.

import type { CommandOutcome, CommandRequest, HubCommand } from "@bfb/domain";

import { executeWorkspaceCommand, type HubClientDeps } from "./hub-client.js";

export type PublicCommandOutcome<TResult> =
  | { ok: true; result: TResult; replayed: boolean }
  | { ok: false; error: { code: string; message: string } };

/** Explicit top-level allowlist; business results are not recursively rewritten. */
export function publicCommandOutcome<TResult>(
  outcome: CommandOutcome<TResult>,
): PublicCommandOutcome<TResult> {
  return outcome.ok
    ? { ok: true, result: outcome.result, replayed: outcome.replayed }
    : { ok: false, error: outcome.error };
}

/** Only public human and delegated transports opt into this receipt projection. */
export async function executePublicWorkspaceCommand<TInput, TResult>(
  deps: HubClientDeps,
  command: HubCommand<TInput, TResult>,
  request: CommandRequest<TInput>,
): Promise<PublicCommandOutcome<TResult>> {
  return publicCommandOutcome(await executeWorkspaceCommand(deps, command, request));
}

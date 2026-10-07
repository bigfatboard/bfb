// ABOUTME: Projects public command receipts without exposing the internal workspace position.
// ABOUTME: Preserves authorized business results and errors while internal transports keep complete Hub outcomes.

import {
  DomainError,
  finalizePublicBusinessResult,
  ownsPublicBusinessDelivery,
  withPublicBusinessAuthority,
  type CommandOutcome,
  type CommandRequest,
  type HubCommand,
} from "@bfb/domain";

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
  if (!ownsPublicBusinessDelivery(command, request.input)) {
    return publicCommandOutcome(await executeWorkspaceCommand(deps, command, request));
  }
  try {
    const authority = deps.publicAuthority;
    if (!authority) throw new DomainError("not_found", "resource not available");
    const retained = {
      ...request,
      input: withPublicBusinessAuthority(command, request.input, authority),
    };
    const outcome = await executeWorkspaceCommand(deps, command, retained);
    if (!outcome.ok) return publicCommandOutcome(outcome);
    // This mandatory selector follows the actual Hub RPC and response.json await.
    const result = await finalizePublicBusinessResult(command, retained.input, outcome.result, {
      db: deps.db,
      workspaceId: request.workspaceId,
      actorHumanId: request.actorHumanId,
      actorDelegationId: request.actorDelegationId,
      actorRunnerId: request.actorRunnerId,
      actorSystemId: request.actorSystemId,
      authorizationEpoch: request.authorizationEpoch,
      now: request.now ?? new Date().toISOString(),
      cursorBase: 0,
    });
    return { ok: true, result, replayed: outcome.replayed };
  } catch (error) {
    if (error instanceof DomainError)
      return { ok: false, error: { code: error.code, message: error.message } };
    throw error;
  }
}

// ABOUTME: Names domain hub commands so Durable Object and local lanes dispatch identically.
// ABOUTME: Transports send command names; only registered commands may mutate workspace state.

import type { HubCommand } from "./hub.js";
import {
  addCommentCommand,
  addContextCommand,
  createTaskCommand,
  updateTaskCommand,
} from "./work-commands.js";
import {
  changeMemberRoleCommand,
  createInvitationCommand,
  removeMemberCommand,
} from "./workspace-authorization.js";

const commands = new Map<string, HubCommand<unknown, unknown>>([
  [createTaskCommand.name, createTaskCommand as HubCommand<unknown, unknown>],
  [updateTaskCommand.name, updateTaskCommand as HubCommand<unknown, unknown>],
  [addCommentCommand.name, addCommentCommand as HubCommand<unknown, unknown>],
  [addContextCommand.name, addContextCommand as HubCommand<unknown, unknown>],
  [createInvitationCommand.name, createInvitationCommand as HubCommand<unknown, unknown>],
  [changeMemberRoleCommand.name, changeMemberRoleCommand as HubCommand<unknown, unknown>],
  [removeMemberCommand.name, removeMemberCommand as HubCommand<unknown, unknown>],
]);

/** Returns a registered hub command by stable name, or undefined when unknown. */
export function resolveCommand(name: string): HubCommand<unknown, unknown> | undefined {
  return commands.get(name);
}

/** Lists registered command names for diagnostics and tests. */
export function listedCommandNames(): string[] {
  return [...commands.keys()].sort();
}

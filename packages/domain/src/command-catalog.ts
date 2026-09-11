// ABOUTME: Names domain hub commands so Durable Object and local lanes dispatch identically.
// ABOUTME: Transports send command names; only registered commands may mutate workspace state.

import type { HubCommand } from "./hub.js";
import { touchRunnerConnectionCommand, replaceRunnerInventoryCommand } from "./runner-channel.js";
import {
  authenticateRunnerRequestCommand,
  enrollRunnerCommand,
  exchangeRunnerTokenCommand,
  issueRunnerChallengeCommand,
  replaceRunnerGrantsCommand,
  revokeRunnerCommand,
} from "./runners.js";
import {
  addCommentCommand,
  addContextCommand,
  addTaskDependencyCommand,
  addTaskLinkCommand,
  createTaskCommand,
  deliverDelegatedAgentContextCommand,
  deliverRunAgentContextCommand,
  reportProgressCommand,
  updateTaskCommand,
} from "./work-commands.js";
import {
  createExecutionCommand,
  createProviderSessionCommand,
  createRunCommand,
  transitionExecutionCommand,
  updateRunActivityCommand,
} from "./work-records.js";
import {
  changeProjectAccessCommand,
  createAgentProfileCommand,
  createProjectCommand,
  reportRepositoryConfigCommand,
  updateAgentProfileCommand,
  updateProjectCommand,
  updateProjectPolicyCommand,
  updateWorkspacePolicyCommand,
} from "./projects.js";
import {
  changeMemberRoleCommand,
  createInvitationCommand,
  removeMemberCommand,
} from "./workspace-authorization.js";

const commands = new Map<string, HubCommand<unknown, unknown>>([
  [touchRunnerConnectionCommand.name, touchRunnerConnectionCommand as HubCommand<unknown, unknown>],
  [
    replaceRunnerInventoryCommand.name,
    replaceRunnerInventoryCommand as HubCommand<unknown, unknown>,
  ],
  [enrollRunnerCommand.name, enrollRunnerCommand as HubCommand<unknown, unknown>],
  [replaceRunnerGrantsCommand.name, replaceRunnerGrantsCommand as HubCommand<unknown, unknown>],
  [revokeRunnerCommand.name, revokeRunnerCommand as HubCommand<unknown, unknown>],
  [issueRunnerChallengeCommand.name, issueRunnerChallengeCommand as HubCommand<unknown, unknown>],
  [exchangeRunnerTokenCommand.name, exchangeRunnerTokenCommand as HubCommand<unknown, unknown>],
  [
    authenticateRunnerRequestCommand.name,
    authenticateRunnerRequestCommand as HubCommand<unknown, unknown>,
  ],
  [createTaskCommand.name, createTaskCommand as HubCommand<unknown, unknown>],
  [updateTaskCommand.name, updateTaskCommand as HubCommand<unknown, unknown>],
  [addCommentCommand.name, addCommentCommand as HubCommand<unknown, unknown>],
  [reportProgressCommand.name, reportProgressCommand as HubCommand<unknown, unknown>],
  [addContextCommand.name, addContextCommand as HubCommand<unknown, unknown>],
  [addTaskDependencyCommand.name, addTaskDependencyCommand as HubCommand<unknown, unknown>],
  [addTaskLinkCommand.name, addTaskLinkCommand as HubCommand<unknown, unknown>],
  [
    deliverDelegatedAgentContextCommand.name,
    deliverDelegatedAgentContextCommand as HubCommand<unknown, unknown>,
  ],
  [
    deliverRunAgentContextCommand.name,
    deliverRunAgentContextCommand as HubCommand<unknown, unknown>,
  ],
  [createRunCommand.name, createRunCommand as HubCommand<unknown, unknown>],
  [updateRunActivityCommand.name, updateRunActivityCommand as HubCommand<unknown, unknown>],
  [createExecutionCommand.name, createExecutionCommand as HubCommand<unknown, unknown>],
  [transitionExecutionCommand.name, transitionExecutionCommand as HubCommand<unknown, unknown>],
  [createProviderSessionCommand.name, createProviderSessionCommand as HubCommand<unknown, unknown>],
  [createInvitationCommand.name, createInvitationCommand as HubCommand<unknown, unknown>],
  [changeMemberRoleCommand.name, changeMemberRoleCommand as HubCommand<unknown, unknown>],
  [removeMemberCommand.name, removeMemberCommand as HubCommand<unknown, unknown>],
  [createProjectCommand.name, createProjectCommand as HubCommand<unknown, unknown>],
  [updateProjectCommand.name, updateProjectCommand as HubCommand<unknown, unknown>],
  [changeProjectAccessCommand.name, changeProjectAccessCommand as HubCommand<unknown, unknown>],
  [updateWorkspacePolicyCommand.name, updateWorkspacePolicyCommand as HubCommand<unknown, unknown>],
  [updateProjectPolicyCommand.name, updateProjectPolicyCommand as HubCommand<unknown, unknown>],
  [
    reportRepositoryConfigCommand.name,
    reportRepositoryConfigCommand as HubCommand<unknown, unknown>,
  ],
  [createAgentProfileCommand.name, createAgentProfileCommand as HubCommand<unknown, unknown>],
  [updateAgentProfileCommand.name, updateAgentProfileCommand as HubCommand<unknown, unknown>],
]);

/** Returns a registered hub command by stable name, or undefined when unknown. */
export function resolveCommand(name: string): HubCommand<unknown, unknown> | undefined {
  return commands.get(name);
}

/** Lists registered command names for diagnostics and tests. */
export function listedCommandNames(): string[] {
  return [...commands.keys()].sort();
}

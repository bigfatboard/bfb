// ABOUTME: Names domain hub commands so Durable Object and local lanes dispatch identically.
// ABOUTME: Transports send command names; only registered commands may mutate workspace state.

import type { HubCommand } from "./hub.js";
import { createViewGrantCommand } from "./artifact-views.js";
import {
  createArtifactCommand,
  finalizeArtifactCommand,
  issueArtifactGrantCommand,
  markArtifactFailedCommand,
} from "./artifacts.js";
import {
  answerAttentionCommand,
  requestAttentionCommand,
  resolveAttentionCommand,
} from "./attention.js";
import {
  recordBrowserActivityCommand,
  reportIntervalCommand,
  reportTokensCommand,
  startReviewTimerCommand,
  stopReviewTimerCommand,
} from "./measurements.js";
import {
  createDiscussionCommand,
  changeDiscussionCommand,
  concludeDiscussionCommand,
} from "./discussions.js";
import { ingestRunnerEventsCommand } from "./events.js";
import { changeDiscussionTurnCommand } from "./discussion-turns.js";
import {
  startLaunchCommand,
  claimLaunchCommand,
  reconcileLaunchCommand,
  authorizeLaunchCommand,
  rejectLaunchCommand,
  tightenLaunchCommand,
} from "./launches.js";
import { issueLaunchWakeCommand, redeemLaunchWakeCommand } from "./launch-wake.js";
import { observeCheckoutLeaseCommand } from "./checkout-leases.js";
import {
  createRunControlCommand,
  claimRunControlCommand,
  acknowledgeRunControlCommand,
} from "./run-controls.js";
import { touchRunnerConnectionCommand, replaceRunnerInventoryCommand } from "./runner-channel.js";
import {
  authorizeDeviceCommand,
  exchangeCredentialCommand,
  revokeBindingCommand,
} from "./cli-credentials.js";
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
  acceptResultCommand,
  cancelRunCommand,
  failRunCommand,
  requestChangesCommand,
  submitResultCommand,
} from "./results.js";
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
  [ingestRunnerEventsCommand.name, ingestRunnerEventsCommand as HubCommand<unknown, unknown>],
  [requestAttentionCommand.name, requestAttentionCommand as HubCommand<unknown, unknown>],
  [answerAttentionCommand.name, answerAttentionCommand as HubCommand<unknown, unknown>],
  [resolveAttentionCommand.name, resolveAttentionCommand as HubCommand<unknown, unknown>],
  [reportTokensCommand.name, reportTokensCommand as HubCommand<unknown, unknown>],
  [reportIntervalCommand.name, reportIntervalCommand as HubCommand<unknown, unknown>],
  [startReviewTimerCommand.name, startReviewTimerCommand as HubCommand<unknown, unknown>],
  [stopReviewTimerCommand.name, stopReviewTimerCommand as HubCommand<unknown, unknown>],
  [recordBrowserActivityCommand.name, recordBrowserActivityCommand as HubCommand<unknown, unknown>],
  [createDiscussionCommand.name, createDiscussionCommand as HubCommand<unknown, unknown>],
  [changeDiscussionCommand.name, changeDiscussionCommand as HubCommand<unknown, unknown>],
  [concludeDiscussionCommand.name, concludeDiscussionCommand as HubCommand<unknown, unknown>],
  [changeDiscussionTurnCommand.name, changeDiscussionTurnCommand as HubCommand<unknown, unknown>],
  [startLaunchCommand.name, startLaunchCommand as HubCommand<unknown, unknown>],
  [claimLaunchCommand.name, claimLaunchCommand as HubCommand<unknown, unknown>],
  [reconcileLaunchCommand.name, reconcileLaunchCommand as HubCommand<unknown, unknown>],
  [authorizeLaunchCommand.name, authorizeLaunchCommand as HubCommand<unknown, unknown>],
  [rejectLaunchCommand.name, rejectLaunchCommand as HubCommand<unknown, unknown>],
  [tightenLaunchCommand.name, tightenLaunchCommand as HubCommand<unknown, unknown>],
  [issueLaunchWakeCommand.name, issueLaunchWakeCommand as HubCommand<unknown, unknown>],
  [redeemLaunchWakeCommand.name, redeemLaunchWakeCommand as HubCommand<unknown, unknown>],
  [observeCheckoutLeaseCommand.name, observeCheckoutLeaseCommand as HubCommand<unknown, unknown>],
  [createRunControlCommand.name, createRunControlCommand as HubCommand<unknown, unknown>],
  [claimRunControlCommand.name, claimRunControlCommand as HubCommand<unknown, unknown>],
  [acknowledgeRunControlCommand.name, acknowledgeRunControlCommand as HubCommand<unknown, unknown>],
  [touchRunnerConnectionCommand.name, touchRunnerConnectionCommand as HubCommand<unknown, unknown>],
  [
    replaceRunnerInventoryCommand.name,
    replaceRunnerInventoryCommand as HubCommand<unknown, unknown>,
  ],
  [createArtifactCommand.name, createArtifactCommand as HubCommand<unknown, unknown>],
  [issueArtifactGrantCommand.name, issueArtifactGrantCommand as HubCommand<unknown, unknown>],
  [finalizeArtifactCommand.name, finalizeArtifactCommand as HubCommand<unknown, unknown>],
  [markArtifactFailedCommand.name, markArtifactFailedCommand as HubCommand<unknown, unknown>],
  [createViewGrantCommand.name, createViewGrantCommand as HubCommand<unknown, unknown>],
  [authorizeDeviceCommand.name, authorizeDeviceCommand as HubCommand<unknown, unknown>],
  [exchangeCredentialCommand.name, exchangeCredentialCommand as HubCommand<unknown, unknown>],
  [revokeBindingCommand.name, revokeBindingCommand as HubCommand<unknown, unknown>],
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
  [submitResultCommand.name, submitResultCommand as HubCommand<unknown, unknown>],
  [requestChangesCommand.name, requestChangesCommand as HubCommand<unknown, unknown>],
  [acceptResultCommand.name, acceptResultCommand as HubCommand<unknown, unknown>],
  [failRunCommand.name, failRunCommand as HubCommand<unknown, unknown>],
  [cancelRunCommand.name, cancelRunCommand as HubCommand<unknown, unknown>],
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

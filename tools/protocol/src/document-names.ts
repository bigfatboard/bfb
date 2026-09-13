// ABOUTME: Lists the ordered F02 wire document names and schema filenames.
// ABOUTME: The generator and codec load exactly this catalog; feature packages append later.

export interface DocumentSpec {
  name: string;
  schemaFile: string;
  goType: string;
  tsType: string;
}

export const PROTOCOL_HEAD = "bfb-wire/1";
export const SCHEMA_VERSION = 1;

export const DOCUMENTS: DocumentSpec[] = [
  {
    name: "event-envelope",
    schemaFile: "event-envelope.json",
    goType: "EventEnvelope",
    tsType: "EventEnvelope",
  },
  {
    name: "event-disposition",
    schemaFile: "event-disposition.json",
    goType: "EventDisposition",
    tsType: "EventDisposition",
  },
  {
    name: "runner-enrollment",
    schemaFile: "runner-enrollment.json",
    goType: "RunnerEnrollment",
    tsType: "RunnerEnrollment",
  },
  {
    name: "runner-identity",
    schemaFile: "runner-identity.json",
    goType: "RunnerIdentity",
    tsType: "RunnerIdentity",
  },
  {
    name: "runner-challenge",
    schemaFile: "runner-challenge.json",
    goType: "RunnerChallenge",
    tsType: "RunnerChallenge",
  },
  {
    name: "runner-channel-close",
    schemaFile: "runner-channel-close.json",
    goType: "RunnerChannelClose",
    tsType: "RunnerChannelClose",
  },
  {
    name: "checkout-summary",
    schemaFile: "checkout-summary.json",
    goType: "CheckoutSummary",
    tsType: "CheckoutSummary",
  },
  {
    name: "runner-local-enrollment",
    schemaFile: "runner-local-enrollment.json",
    goType: "RunnerLocalEnrollment",
    tsType: "RunnerLocalEnrollment",
  },
  {
    name: "runner-enrollment-handoff",
    schemaFile: "runner-enrollment-handoff.json",
    goType: "RunnerEnrollmentHandoff",
    tsType: "RunnerEnrollmentHandoff",
  },
  {
    name: "runner-channel-message",
    schemaFile: "runner-channel-message.json",
    goType: "RunnerChannelMessage",
    tsType: "RunnerChannelMessage",
  },
  {
    name: "runner-command-pull",
    schemaFile: "runner-command-pull.json",
    goType: "RunnerCommandPull",
    tsType: "RunnerCommandPull",
  },
  {
    name: "runner-inventory",
    schemaFile: "runner-inventory.json",
    goType: "RunnerInventory",
    tsType: "RunnerInventory",
  },
  {
    name: "execution-assignment",
    schemaFile: "execution-assignment.json",
    goType: "ExecutionAssignment",
    tsType: "ExecutionAssignment",
  },
  {
    name: "launch-specification",
    schemaFile: "launch-specification.json",
    goType: "LaunchSpecification",
    tsType: "LaunchSpecification",
  },
  {
    name: "launch-claim",
    schemaFile: "launch-claim.json",
    goType: "LaunchClaim",
    tsType: "LaunchClaim",
  },
  {
    name: "final-authorization",
    schemaFile: "final-authorization.json",
    goType: "FinalAuthorization",
    tsType: "FinalAuthorization",
  },
  {
    name: "cloud-wake-intent",
    schemaFile: "cloud-wake-intent.json",
    goType: "CloudWakeIntent",
    tsType: "CloudWakeIntent",
  },
  {
    name: "terminal-intent",
    schemaFile: "terminal-intent.json",
    goType: "TerminalIntent",
    tsType: "TerminalIntent",
  },
  {
    name: "local-rpc",
    schemaFile: "local-rpc.json",
    goType: "LocalRpcEnvelope",
    tsType: "LocalRpcEnvelope",
  },
  {
    name: "local-execution-assignment",
    schemaFile: "local-execution-assignment.json",
    goType: "LocalExecutionAssignment",
    tsType: "LocalExecutionAssignment",
  },
  {
    name: "runner-event-submission",
    schemaFile: "runner-event-submission.json",
    goType: "RunnerEventSubmission",
    tsType: "RunnerEventSubmission",
  },
  {
    name: "typed-error",
    schemaFile: "typed-error.json",
    goType: "TypedError",
    tsType: "TypedError",
  },
  {
    name: "launch-start-request",
    schemaFile: "launch-start-request.json",
    goType: "LaunchStartRequest",
    tsType: "LaunchStartRequest",
  },
  {
    name: "launch-snapshot",
    schemaFile: "launch-snapshot.json",
    goType: "LaunchSnapshot",
    tsType: "LaunchSnapshot",
  },
  {
    name: "launch-claim-result",
    schemaFile: "launch-claim-result.json",
    goType: "LaunchClaimResult",
    tsType: "LaunchClaimResult",
  },
  {
    name: "launch-final-request",
    schemaFile: "launch-final-request.json",
    goType: "LaunchFinalRequest",
    tsType: "LaunchFinalRequest",
  },
  {
    name: "launch-reconciliation",
    schemaFile: "launch-reconciliation.json",
    goType: "LaunchReconciliation",
    tsType: "LaunchReconciliation",
  },
  {
    name: "checkout-lease-observation",
    schemaFile: "checkout-lease-observation.json",
    goType: "CheckoutLeaseObservation",
    tsType: "CheckoutLeaseObservation",
  },
  {
    name: "run-control-request",
    schemaFile: "run-control-request.json",
    goType: "RunControlRequest",
    tsType: "RunControlRequest",
  },
  {
    name: "run-control-claim",
    schemaFile: "run-control-claim.json",
    goType: "RunControlClaim",
    tsType: "RunControlClaim",
  },
  {
    name: "run-control-disposition",
    schemaFile: "run-control-disposition.json",
    goType: "RunControlDisposition",
    tsType: "RunControlDisposition",
  },
  {
    name: "launch-reject-request",
    schemaFile: "launch-reject-request.json",
    goType: "LaunchRejectRequest",
    tsType: "LaunchRejectRequest",
  },
  {
    name: "launch-tighten-request",
    schemaFile: "launch-tighten-request.json",
    goType: "LaunchTightenRequest",
    tsType: "LaunchTightenRequest",
  },
  {
    name: "launch-wake-request",
    schemaFile: "launch-wake-request.json",
    goType: "LaunchWakeRequest",
    tsType: "LaunchWakeRequest",
  },
  {
    name: "launch-wake-redemption",
    schemaFile: "launch-wake-redemption.json",
    goType: "LaunchWakeRedemption",
    tsType: "LaunchWakeRedemption",
  },
  {
    name: "run-control-reference",
    schemaFile: "run-control-reference.json",
    goType: "RunControlReference",
    tsType: "RunControlReference",
  },
  {
    name: "run-control-result",
    schemaFile: "run-control-result.json",
    goType: "RunControlResult",
    tsType: "RunControlResult",
  },
  {
    name: "local-execution-observation",
    schemaFile: "local-execution-observation.json",
    goType: "LocalExecutionObservation",
    tsType: "LocalExecutionObservation",
  },
  {
    name: "local-execution-control",
    schemaFile: "local-execution-control.json",
    goType: "LocalExecutionControl",
    tsType: "LocalExecutionControl",
  },
  {
    name: "local-execution-focus",
    schemaFile: "local-execution-focus.json",
    goType: "LocalExecutionFocus",
    tsType: "LocalExecutionFocus",
  },
];

export const SHELL_FIELDS = [
  "command",
  "executable",
  "cwd",
  "argv",
  "shell",
  "working_directory",
  "task_text",
  "task_body",
  "prompt",
] as const;

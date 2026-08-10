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
    name: "checkout-summary",
    schemaFile: "checkout-summary.json",
    goType: "CheckoutSummary",
    tsType: "CheckoutSummary",
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

// ABOUTME: Typed D03 browser client for task-linked discussion reads and human decisions.
// ABOUTME: Request builders use exact field allowlists; peer text never becomes launch authority.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function browserUlid(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let out = "01";
  for (const byte of bytes) {
    out += CROCKFORD[byte % 32];
    if (out.length >= 26) {
      break;
    }
  }
  return out.slice(0, 26);
}

export function newDiscussionKey(): string {
  return browserUlid();
}

export interface DiscussionParticipantSummary {
  id: string;
  run_id: string;
  agent_profile_id: string;
  name: string;
  provider: "claude" | "codex";
  runner_id: string;
  checkout_id: string;
}

export interface DiscussionTurnSummary {
  id: string;
  participant_id: string;
  ordinal: number;
  state: "planned" | "active" | "completed" | "failed" | "cancelled";
  version: number;
  delivery?: {
    id: string;
    version: number;
    state: "accepted" | "dispatched" | "acknowledged" | "completed" | "ambiguous" | "failed";
    session_id?: string;
    source_message_ids: string[];
  };
}

export interface DiscussionOutput {
  schema_version: 1;
  recommendation: string;
  reasons: string[];
  evidence: {
    kind: "context" | "repository";
    context_id?: string;
    repository_path?: string;
    git_revision?: string;
    line?: number;
    explanation: string;
  }[];
  agreement: { message_id: string; reason: string }[];
  disagreements: { message_id: string; reason: string }[];
  human_questions: string[];
}

export interface DiscussionMessageSummary {
  id: string;
  kind: "intervention" | "recommendation";
  created_at: string;
  author_human_id?: string;
  participant_id?: string;
  run_id?: string;
  session_id?: string;
  turn_id?: string;
  text?: string;
  output?: DiscussionOutput;
}

export type DiscussionState = "active" | "paused" | "concluded" | "cancelled" | "failed";

export type DiscussionReason =
  | "human_cancelled"
  | "deadline_exceeded"
  | "context_changed"
  | "sponsor_revoked"
  | "delivery_ambiguous"
  | "provider_failed";

export interface DiscussionView {
  schema_version: 1;
  scope: "human";
  discussion_id: string;
  task_id: string;
  state: DiscussionState;
  reason?: DiscussionReason;
  version: number;
  deadline: string;
  brief_hash: string;
  brief: {
    schema_version: 1;
    task_id: string;
    title: string;
    question: string;
    git_revision: string;
    context: {
      id: string;
      kind: string;
      body: string;
      version: number;
      audience: string;
      content_hash: string;
      created_at: string;
    }[];
  };
  dispatch_block_reason?: "deadline_exceeded" | "context_changed" | "sponsor_revoked";
  participants: DiscussionParticipantSummary[];
  turns: DiscussionTurnSummary[];
  messages: DiscussionMessageSummary[];
  conclusion?: { recommendation_ids: string[]; created_at: string };
  decision?: {
    id: string;
    human_id: string;
    kind: "record_recommendation" | "decline" | "needs_more_context";
    summary: string;
    recommendation_ids: string[];
    created_at: string;
  };
}

export interface DiscussionListEntry {
  id: string;
  state: DiscussionState;
  version: number;
  deadline: string;
  created_at: string;
}

export interface AgentProfileRecord {
  id: string;
  name: string;
  provider: string;
  model: string | null;
  execution_mode: "interactive" | "headless";
  harness_mode: "restricted" | "standard";
  resource_version: number;
}

export interface DiscussionClient {
  list(taskId: string): Promise<{ discussions: DiscussionListEntry[]; has_more: boolean }>;
  read(discussionId: string): Promise<{ discussion: DiscussionView }>;
  create(body: Record<string, unknown>): Promise<Response>;
  change(discussionId: string, body: Record<string, unknown>): Promise<Response>;
}

export function createDiscussionClient(
  fetchFn: typeof fetch,
  workspaceId: string,
  csrfToken: string,
): DiscussionClient {
  const base = `/api/v1/workspaces/${workspaceId}`;
  async function get<T>(path: string): Promise<T> {
    const response = await fetchFn(path);
    if (!response.ok) {
      throw new Error(`Discussion read failed (${response.status})`);
    }
    return (await response.json()) as T;
  }
  function post(path: string, body: Record<string, unknown>): Promise<Response> {
    return fetchFn(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bfb-csrf": csrfToken },
      body: JSON.stringify(body),
    });
  }
  return {
    list: (taskId) => get(`${base}/tasks/${encodeURIComponent(taskId)}/discussions?limit=50`),
    read: (discussionId) => get(`${base}/discussions/${encodeURIComponent(discussionId)}`),
    create: (body) =>
      post(`${base}/tasks/${encodeURIComponent(String(body.task_id))}/discussions`, body),
    change: (discussionId, body) =>
      post(`${base}/discussions/${encodeURIComponent(discussionId)}`, body),
  };
}

export interface CreateParticipantInput {
  agentProfileId: string;
  agentProfileVersion: number;
  runnerId: string;
  checkoutId: string;
}

export interface CreateDiscussionInput {
  taskId: string;
  expectedTaskVersion: number;
  question: string;
  gitRevision: string;
  workspacePolicyVersion: number;
  projectPolicyVersion: number;
  repositoryConfigVersion: number;
  participants: [CreateParticipantInput, CreateParticipantInput];
  rounds?: number;
  durationSeconds?: number;
  idempotencyKey: string;
}

const CREATE_PARTICIPANT_KEYS = [
  "agent_profile_id",
  "agent_profile_version",
  "checkout_id",
  "runner_id",
].sort();

/** Exact D01 create fields. No execution, lease, or provider-argv field is permitted. */
export function buildCreateRequest(input: CreateDiscussionInput): Record<string, unknown> {
  return {
    schema_version: 1,
    idempotency_key: input.idempotencyKey,
    task_id: input.taskId,
    expected_task_version: input.expectedTaskVersion,
    question: input.question,
    git_revision: input.gitRevision,
    workspace_policy_version: input.workspacePolicyVersion,
    project_policy_version: input.projectPolicyVersion,
    repository_config_version: input.repositoryConfigVersion,
    participants: input.participants.map((participant) => ({
      agent_profile_id: participant.agentProfileId,
      agent_profile_version: participant.agentProfileVersion,
      runner_id: participant.runnerId,
      checkout_id: participant.checkoutId,
    })),
    ...(input.rounds === undefined ? {} : { rounds: input.rounds }),
    ...(input.durationSeconds === undefined ? {} : { duration_seconds: input.durationSeconds }),
  };
}

export function createParticipantKeys(): string[] {
  return [...CREATE_PARTICIPANT_KEYS];
}

export type ChangeAction = "intervene" | "cancel" | "conclude" | "decide";

export interface DecisionInput {
  kind: "record_recommendation" | "decline" | "needs_more_context";
  summary: string;
  recommendationIds: string[];
}

/** Exact D01 change fields per action. A decision is human-only and references stored recommendations. */
export function buildChangeRequest(input: {
  discussionId: string;
  expectedVersion: number;
  action: ChangeAction;
  text?: string;
  decision?: DecisionInput;
  idempotencyKey: string;
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    schema_version: 1,
    idempotency_key: input.idempotencyKey,
    discussion_id: input.discussionId,
    expected_version: input.expectedVersion,
    action: input.action,
  };
  if (input.action === "intervene" && input.text !== undefined) {
    base.text = input.text;
  }
  if (input.action === "decide" && input.decision) {
    base.decision = {
      kind: input.decision.kind,
      summary: input.decision.summary,
      recommendation_ids: input.decision.recommendationIds,
    };
  }
  return base;
}

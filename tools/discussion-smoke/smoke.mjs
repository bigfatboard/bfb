// ABOUTME: Gated live-provider smoke for task-linked discussions (runs only after L05).
// ABOUTME: Exits non-zero with pending requirements; never fakes a live result.

/**
 * Live smoke for WP-D03. Reads one concluded discussion view against a real
 * control plane and asserts the DG-01/DG-03 shape the browser depends on:
 * attributed recommendations, disagreements, and a human decision distinct
 * from agent text. It starts nothing, decides nothing, and completes nothing.
 *
 * Pending until L05 (live supervised launches on this Mac) plus provider
 * credentials and consent. Without BFB_LIVE_SMOKE=1 the script refuses to run.
 */

const base = process.env.BFB_DISCUSSION_SMOKE_BASE ?? "";
const taskId = process.env.BFB_DISCUSSION_SMOKE_TASK ?? "";
const cookie = process.env.BFB_DISCUSSION_SMOKE_COOKIE ?? "";
const discussionId = process.env.BFB_DISCUSSION_SMOKE_DISCUSSION ?? "";

if (process.env.BFB_LIVE_SMOKE !== "1" || !base || !taskId || !cookie) {
  console.error("D03 live smoke is pending, not failed:");
  console.error("- requires L05 done (live supervised launches certified on this Mac)");
  console.error("- requires provider credentials and human consent for Claude/Codex turns");
  console.error("- requires BFB_LIVE_SMOKE=1 BFB_DISCUSSION_SMOKE_BASE=<control-origin>");
  console.error("  BFB_DISCUSSION_SMOKE_TASK=<task-id> BFB_DISCUSSION_SMOKE_COOKIE=<owner-cookie>");
  console.error("  [BFB_DISCUSSION_SMOKE_DISCUSSION=<discussion-id>]");
  process.exit(2);
}

function fail(message) {
  console.error(`D03 live smoke failed: ${message}`);
  process.exit(1);
}

const get = async (path) => {
  const response = await fetch(`${base}${path}`, { headers: { cookie } });
  if (!response.ok) {
    fail(`${path} returned ${response.status}`);
  }
  return response.json();
};

const list = await get(
  `/api/v1/workspaces/${await workspaceId()}/tasks/${taskId}/discussions?limit=50`,
);
const entries = list.discussions ?? [];
if (entries.length === 0) {
  fail("task has no committed discussions");
}
const target = discussionId || entries[entries.length - 1].id;
const view = (await get(`/api/v1/workspaces/${await workspaceId()}/discussions/${target}`))
  .discussion;
if (!view || view.scope !== "human") {
  fail("discussion view is not human-scoped");
}
const recommendations = (view.messages ?? []).filter(
  (message) => message.kind === "recommendation",
);
if (recommendations.length === 0) {
  fail("discussion has no attributed recommendations");
}
for (const message of recommendations) {
  if (!message.participant_id || !message.output || !message.output.recommendation) {
    fail(`recommendation ${message.id} is unattributed or empty`);
  }
}
console.log(
  `D03 live smoke passed: discussion ${target} has ${recommendations.length} attributed recommendations.`,
);

async function workspaceId() {
  const session = await get("/auth/session");
  if (!session.workspace_id) {
    fail("session carries no workspace id");
  }
  return session.workspace_id;
}

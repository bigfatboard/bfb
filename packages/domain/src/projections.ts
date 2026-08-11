// ABOUTME: Builds deterministic Work surface projections from committed task state.
// ABOUTME: Never invents realtime presence, agent activity, time, tokens, or completion.

import type { SqlDatabase } from "@bfb/db";

import type { TaskRecord } from "./work-commands.js";
import { listTasks } from "./work-commands.js";

export interface ProjectLane {
  projectId: string;
  name: string;
  slug: string;
  tint: string;
  tasks: BoardCard[];
}

export interface BoardCard {
  taskId: string;
  projectId: string;
  title: string;
  priority: string;
  state: string;
  punchline: string;
  nowLabel: "NOW";
  whyHuman?: string;
  whyDelegable?: string;
  passToAgentProfileId?: string;
  projectTint: string;
  topEdgePx: 3;
  sideStripe: false;
}

export interface AttentionDeckItem {
  taskId: string;
  projectId: string;
  title: string;
  priority: string;
  punchline: string;
  reason: string;
}

function toCard(
  task: TaskRecord,
  project: { id: string; tint: string; allow_pass_to_agent: number },
): BoardCard {
  const card: BoardCard = {
    taskId: task.id,
    projectId: task.project_id,
    title: task.title,
    priority: task.priority,
    state: task.state,
    punchline: task.punchline,
    nowLabel: "NOW",
    projectTint: project.tint,
    topEdgePx: 3,
    sideStripe: false,
  };
  if (task.next_owner_type === "human" && task.next_action_reason) {
    card.whyHuman = task.next_action_reason;
  }
  if (task.next_owner_type === "agent_profile" && task.next_action_reason) {
    card.whyDelegable = task.next_action_reason;
  }
  if (
    project.allow_pass_to_agent === 1 &&
    task.next_owner_type === "agent_profile" &&
    task.next_owner_id
  ) {
    card.passToAgentProfileId = task.next_owner_id;
  }
  return card;
}

export async function buildProjectLanes(
  db: SqlDatabase,
  workspaceId: string,
  projectIds: string[],
): Promise<ProjectLane[]> {
  const projects = (
    (await db
      .prepare(
        `SELECT p.id, p.name, p.slug, p.tint,
                CASE WHEN wp.allow_pass_to_agent = 1
                       AND pp.allow_pass_to_agent = 1
                       AND rc.allow_pass_to_agent = 1
                     THEN 1 ELSE 0 END AS allow_pass_to_agent
         FROM projects p
         JOIN workspace_policies wp ON wp.workspace_id = p.workspace_id
         JOIN project_policies pp
           ON pp.workspace_id = p.workspace_id AND pp.project_id = p.id
         JOIN repository_configs rc
           ON rc.workspace_id = p.workspace_id AND rc.project_id = p.id
         WHERE p.workspace_id = ?
         ORDER BY p.slug ASC`,
      )
      .all(workspaceId)) as Array<{
      id: string;
      name: string;
      slug: string;
      tint: string;
      allow_pass_to_agent: number;
    }>
  ).filter((project) => projectIds.includes(project.id));

  const tasks = await listTasks(db, workspaceId, projectIds);
  return projects.map((project) => ({
    projectId: project.id,
    name: project.name,
    slug: project.slug,
    tint: project.tint,
    tasks: tasks
      .filter((task) => task.project_id === project.id)
      .map((task) => toCard(task, project)),
  }));
}

export async function buildNeedsNowDeck(
  db: SqlDatabase,
  workspaceId: string,
  humanId: string,
  projectIds: string[],
  nowIso: string,
): Promise<AttentionDeckItem[]> {
  if (projectIds.length === 0) {
    return [];
  }
  const placeholders = projectIds.map(() => "?").join(", ");
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) {
    return [];
  }
  const eligible = (await db
    .prepare(
      `SELECT id, project_id, title, priority, punchline, next_action_reason
       FROM tasks
       WHERE workspace_id = ? AND project_id IN (${placeholders})
         AND next_owner_type = 'human' AND next_owner_id = ?
         AND priority IN ('P0', 'P1')
         AND (state = 'blocked' OR (due_at IS NOT NULL AND due_at <= ?))
       ORDER BY CASE priority WHEN 'P0' THEN 0 ELSE 1 END,
                CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,
                due_at ASC, id ASC
       LIMIT 3`,
    )
    .all(workspaceId, ...projectIds, humanId, nowIso)) as Array<{
    id: string;
    project_id: string;
    title: string;
    priority: string;
    punchline: string;
    next_action_reason: string | null;
  }>;
  return eligible.map((task) => ({
    taskId: task.id,
    projectId: task.project_id,
    title: task.title,
    priority: task.priority,
    punchline: task.punchline,
    reason: task.next_action_reason ?? "Needs current human",
  }));
}

export function unavailableAgentWorkCopy(): string {
  return "Agent work unavailable";
}

export function mcpActivityCopy(providerLabel: string | undefined, humanName: string): string {
  const provider = providerLabel ?? "MCP client";
  return `${provider} client via ${humanName}'s grant · MCP activity recent`;
}

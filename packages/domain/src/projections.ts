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
  if (project.allow_pass_to_agent === 1 && task.next_owner_type === "unassigned") {
    card.passToAgentProfileId = "policy-allowed";
  }
  return card;
}

export function buildProjectLanes(
  db: SqlDatabase,
  workspaceId: string,
  projectIds: string[],
): ProjectLane[] {
  const projects = (
    db
      .prepare(
        `SELECT p.id, p.name, p.slug, p.tint, COALESCE(pp.allow_pass_to_agent, 0) AS allow_pass_to_agent
         FROM projects p
         LEFT JOIN project_policies pp
           ON pp.workspace_id = p.workspace_id AND pp.project_id = p.id
         WHERE p.workspace_id = ?
         ORDER BY p.slug ASC`,
      )
      .all(workspaceId) as Array<{
      id: string;
      name: string;
      slug: string;
      tint: string;
      allow_pass_to_agent: number;
    }>
  ).filter((project) => projectIds.includes(project.id));

  const tasks = listTasks(db, workspaceId, projectIds);
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

export function buildNeedsNowDeck(
  db: SqlDatabase,
  workspaceId: string,
  humanId: string,
  projectIds: string[],
  nowIso: string,
): AttentionDeckItem[] {
  const tasks = listTasks(db, workspaceId, projectIds);
  const now = Date.parse(nowIso);
  const eligible = tasks.filter((task) => {
    if (task.next_owner_type !== "human" || task.next_owner_id !== humanId) {
      return false;
    }
    if (task.priority !== "P0" && task.priority !== "P1") {
      return false;
    }
    const blocked = task.state === "blocked";
    const due = task.due_at !== null && Date.parse(task.due_at) <= now;
    return blocked || due;
  });
  eligible.sort((left, right) => {
    const priority = left.priority.localeCompare(right.priority);
    if (priority !== 0) {
      return priority;
    }
    const dueLeft = left.due_at ?? "9999";
    const dueRight = right.due_at ?? "9999";
    const dueCmp = dueLeft.localeCompare(dueRight);
    if (dueCmp !== 0) {
      return dueCmp;
    }
    return left.id.localeCompare(right.id);
  });
  return eligible.slice(0, 3).map((task) => ({
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

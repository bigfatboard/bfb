// ABOUTME: Seeds explicit synthetic task history in migration fixtures that predate private-task authority.
// ABOUTME: Rejects current schemas so modern fixtures continue exercising real task commands.

import type { SqlDatabase } from "@bfb/db";

import { randomUlid } from "../src/ids.js";
import type { TaskRecord } from "../src/work-commands.js";

export async function seedHistoricalTask(
  db: SqlDatabase,
  input: { workspaceId: string; projectId: string; humanId: string; title: string; now: string },
): Promise<TaskRecord> {
  if (
    await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_privacy'").get()
  )
    throw new Error("historical task fixture requires pre-private-authority schema");
  const task: TaskRecord = {
    id: randomUlid(),
    project_id: input.projectId,
    parent_task_id: null,
    title: input.title,
    state: "ready",
    priority: "P2",
    due_at: null,
    next_owner_type: "unassigned",
    next_owner_id: null,
    next_action_reason: null,
    punchline: "Ready for next action",
    resource_version: 1,
  };
  await db
    .prepare(
      `INSERT INTO tasks
    (workspace_id,id,project_id,parent_task_id,title,state,priority,due_at,next_owner_type,
     next_owner_id,next_action_reason,punchline,resource_version,created_by_human_id,
     created_by_delegation_id,created_at)
    VALUES (?,?,?,NULL,?,'ready','P2',NULL,'unassigned',NULL,NULL,?,1,?,NULL,?)`,
    )
    .run(
      input.workspaceId,
      task.id,
      input.projectId,
      input.title,
      task.punchline,
      input.humanId,
      input.now,
    );
  return task;
}

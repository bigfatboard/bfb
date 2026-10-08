// ABOUTME: Selects canonical Work lanes and the independent attention deck under current authority.
// ABOUTME: Recorded run summaries remain distinct from unavailable event metadata and live execution.

import type { SqlDatabase } from "@bfb/db";
import type { WorkspaceRole } from "./authorization.js";
import { DomainError } from "./hub.js";
import type { TaskRecord } from "./work-commands.js";
import { sharedTaskPredicate, taskAccessPredicate, type TaskAccessContext } from "./task-access.js";

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
  humanOwnerName?: string;
  whyDelegable?: string;
  passToAgentProfileId?: string;
  projectTint: string;
  topEdgePx: 3;
  sideStripe: false;
  runSummary?: { resultState: string; activity: string };
}

export interface AttentionDeckItem {
  taskId: string;
  projectId: string;
  title: string;
  priority: string;
  punchline: string;
  reason: string;
}

export interface WorkBoardProjection {
  lanes: ProjectLane[];
  needsNow: AttentionDeckItem[];
  role: WorkspaceRole;
  authorizationEpoch: number;
  recentEventsAvailable: false;
}

type CardTask = Pick<
  TaskRecord,
  | "id"
  | "project_id"
  | "title"
  | "priority"
  | "state"
  | "punchline"
  | "next_owner_type"
  | "next_owner_id"
  | "next_action_reason"
>;
interface SelectedCard extends CardTask {
  human_owner_name: string | null;
  run_result_state: string | null;
  run_activity: string | null;
}
interface LaneProject {
  id: string;
  name: string;
  slug: string;
  tint: string;
  allow_pass_to_agent: number;
}

function toCard(task: SelectedCard, project: LaneProject): BoardCard {
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
    if (task.human_owner_name) card.humanOwnerName = task.human_owner_name;
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
  if (task.run_result_state !== null && task.run_activity !== null) {
    card.runSummary = { resultState: task.run_result_state, activity: task.run_activity };
  }
  return card;
}

function boardUlid(column: string): string {
  return `(typeof(${column})='text' AND instr(${column},char(0))=0 AND length(${column})=26
    AND substr(${column},1,1) GLOB '[0-7]' AND ${column} NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*')`;
}

/** Keep each GLOB below D1's 50-byte pattern ceiling and reject SQLite's NUL-prefix behavior. */
function boardUtc(column: string): string {
  return `(typeof(${column})='text' AND instr(${column},char(0))=0
    AND substr(${column},1,10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND substr(${column},11,1)='T' AND substr(${column},12,8) GLOB '[0-9][0-9]:[0-9][0-9]:[0-5][0-9]'
    AND date(substr(${column},1,10),'+0 days')=substr(${column},1,10)
    AND CAST(substr(${column},12,2) AS INTEGER)<=23 AND CAST(substr(${column},15,2) AS INTEGER)<=59
    AND ((length(${column})=20 AND substr(${column},20,1)='Z')
      OR (length(${column}) BETWEEN 22 AND 27 AND substr(${column},20,1)='.' AND substr(${column},-1)='Z'
        AND substr(${column},21,length(${column})-21) NOT GLOB '*[^0-9]*')))`;
}

function boardUtcOrderKey(column: string): string {
  return `(substr(${column},1,19)||'.'||substr(CASE WHEN length(${column})=20 THEN '000000'
    ELSE substr(${column},21,length(${column})-21)||'000000' END,1,6))`;
}

/** One selecting statement is the delivery boundary; later reconstruction is synchronous. */
async function selectWorkBoard(
  db: SqlDatabase,
  workspaceId: string,
  projectIds: string[],
  humanId: string | null,
  nowIso: string | null,
  access?: TaskAccessContext,
): Promise<
  Omit<WorkBoardProjection, "role" | "authorizationEpoch"> & {
    role: WorkspaceRole | null;
    authorizationEpoch: number | null;
  }
> {
  const predicate = access
    ? taskAccessPredicate(access, "read")
    : { sql: sharedTaskPredicate(), parameters: [] };
  if (access && humanId !== access.humanId) {
    throw new DomainError("invalid_argument", "board human does not match authenticated access");
  }
  const row = (await db
    .prepare(
      `WITH
    board_request(workspace_id,project_ids,human_id,access_workspace_id,authorization_epoch,now_iso) AS
      (VALUES (?,?,?,?,?,?)),
    board_scope AS MATERIALIZED (
      SELECT workspace.id AS workspace_id,member.role,epoch.authorization_epoch,request.human_id
      FROM board_request AS request JOIN workspaces AS workspace ON workspace.id=request.workspace_id
      LEFT JOIN workspace_members AS member ON member.workspace_id=workspace.id AND member.human_id=request.human_id
      LEFT JOIN workspace_authorization_epochs AS epoch ON epoch.workspace_id=member.workspace_id
        AND epoch.human_id=member.human_id AND epoch.authorization_epoch=member.authorization_epoch AND epoch.revoked_at IS NULL
      WHERE ${
        access
          ? `request.access_workspace_id=workspace.id AND member.role IN ('owner','member','reviewer')
        AND epoch.authorization_epoch=request.authorization_epoch`
          : "1"
      }
    ),
    board_projects AS MATERIALIZED (
      SELECT project.* FROM board_scope AS scope JOIN projects AS project ON project.workspace_id=scope.workspace_id
      JOIN board_request AS request ON request.workspace_id=scope.workspace_id
      WHERE project.id IN (SELECT value FROM json_each(request.project_ids)) AND ${boardUlid("project.id")}
        ${
          access
            ? `AND (project.access_mode='workspace' OR EXISTS (
          SELECT 1 FROM project_access AS grant WHERE grant.workspace_id=project.workspace_id
            AND grant.project_id=project.id AND grant.human_id=scope.human_id))`
            : ""
        }
    ),
    board_tasks AS MATERIALIZED (
      SELECT task.*,CASE WHEN ${boardUtc("task.due_at")} THEN ${boardUtcOrderKey("task.due_at")} END AS due_key
      FROM tasks AS task JOIN board_projects AS project ON project.workspace_id=task.workspace_id AND project.id=task.project_id
      WHERE ${predicate.sql} AND ${boardUlid("task.id")}
    ),
    card_candidates AS MATERIALIZED (SELECT * FROM board_tasks ORDER BY id ASC LIMIT 50),
    lane_projects AS MATERIALIZED (
      SELECT project.id,project.name,project.slug,project.tint,
        CASE WHEN workspace_policy.allow_pass_to_agent=1 AND project_policy.allow_pass_to_agent=1
          AND repository_config.allow_pass_to_agent=1 THEN 1 ELSE 0 END AS allow_pass_to_agent
      FROM board_projects AS project
      JOIN workspace_policies AS workspace_policy ON workspace_policy.workspace_id=project.workspace_id
      JOIN project_policies AS project_policy ON project_policy.workspace_id=project.workspace_id AND project_policy.project_id=project.id
      JOIN repository_configs AS repository_config ON repository_config.workspace_id=project.workspace_id AND repository_config.project_id=project.id
      ORDER BY project.slug ASC
    ),
    board_work_runs AS MATERIALIZED (
      SELECT run.task_id,run.result_state,run.activity,
        ROW_NUMBER() OVER (PARTITION BY run.task_id ORDER BY ${boardUtcOrderKey("run.created_at")} DESC,run.id ASC) AS rank
      FROM runs AS run JOIN card_candidates AS task
        ON task.workspace_id=run.workspace_id AND task.id=run.task_id AND task.project_id=run.project_id
      WHERE run.purpose='work' AND ${boardUlid("run.id")} AND ${boardUlid("run.workspace_id")}
        AND ${boardUlid("run.task_id")} AND ${boardUlid("run.project_id")} AND ${boardUtc("run.created_at")}
    ),
    board_cards AS MATERIALIZED (
      SELECT task.*,human.display_name AS human_owner_name,run.result_state AS run_result_state,run.activity AS run_activity
      FROM card_candidates AS task JOIN lane_projects AS project ON project.id=task.project_id
      LEFT JOIN workspace_members AS owner ON owner.workspace_id=task.workspace_id
        AND owner.human_id=task.next_owner_id AND task.next_owner_type='human'
      LEFT JOIN workspace_authorization_epochs AS owner_epoch ON owner_epoch.workspace_id=owner.workspace_id
        AND owner_epoch.human_id=owner.human_id AND owner_epoch.authorization_epoch=owner.authorization_epoch AND owner_epoch.revoked_at IS NULL
      LEFT JOIN humans AS human ON human.id=owner.human_id AND owner_epoch.human_id IS NOT NULL
      LEFT JOIN board_work_runs AS run ON run.task_id=task.id AND run.rank=1
      ORDER BY task.id ASC
    ),
    deck_clock AS MATERIALIZED (
      SELECT CASE WHEN ${boardUtc("now_iso")} THEN ${boardUtcOrderKey("now_iso")} END AS now_key FROM board_request
    ),
    attention_deck AS MATERIALIZED (
      SELECT task.id AS taskId,task.project_id AS projectId,task.title,task.priority,task.punchline,
        COALESCE(task.next_action_reason,'Needs current human') AS reason
      FROM board_tasks AS task CROSS JOIN board_request AS request CROSS JOIN deck_clock AS clock
      WHERE clock.now_key IS NOT NULL AND task.next_owner_type='human' AND task.next_owner_id=request.human_id
        AND task.priority IN ('P0','P1') AND (task.state='blocked' OR task.due_key<=clock.now_key)
      ORDER BY CASE task.priority WHEN 'P0' THEN 0 ELSE 1 END,
        CASE WHEN task.due_key IS NULL THEN 1 ELSE 0 END,task.due_key ASC,task.id ASC LIMIT 3
    )
    SELECT scope.role,scope.authorization_epoch,
      (SELECT json_group_array(json_object('id',id,'name',name,'slug',slug,'tint',tint,'allow_pass_to_agent',allow_pass_to_agent)) FROM lane_projects) AS projects_json,
      (SELECT json_group_array(json_object('id',id,'project_id',project_id,'title',title,'priority',priority,'state',state,
        'punchline',punchline,'next_owner_type',next_owner_type,'next_owner_id',next_owner_id,'next_action_reason',next_action_reason,
        'human_owner_name',human_owner_name,'run_result_state',run_result_state,'run_activity',run_activity)) FROM board_cards) AS cards_json,
      (SELECT json_group_array(json_object('taskId',taskId,'projectId',projectId,'title',title,'priority',priority,'punchline',punchline,'reason',reason)) FROM attention_deck) AS deck_json
    FROM board_scope AS scope`,
    )
    .get(
      workspaceId,
      JSON.stringify(projectIds),
      humanId,
      access?.workspaceId ?? null,
      access?.authorizationEpoch ?? null,
      nowIso,
      ...predicate.parameters,
    )) as
    | {
        role: WorkspaceRole | null;
        authorization_epoch: number | null;
        projects_json: string;
        cards_json: string;
        deck_json: string;
      }
    | undefined;
  if (!row) {
    if (access) throw new DomainError("not_found", "board scope not found");
    return {
      lanes: [],
      needsNow: [],
      role: null,
      authorizationEpoch: null,
      recentEventsAvailable: false,
    };
  }
  const projects = JSON.parse(row.projects_json) as LaneProject[];
  const cards = JSON.parse(row.cards_json) as SelectedCard[];
  return {
    lanes: projects.map((project) => ({
      projectId: project.id,
      name: project.name,
      slug: project.slug,
      tint: project.tint,
      tasks: cards
        .filter((task) => task.project_id === project.id)
        .map((task) => toCard(task, project)),
    })),
    needsNow: JSON.parse(row.deck_json) as AttentionDeckItem[],
    role: row.role,
    authorizationEpoch: row.authorization_epoch,
    recentEventsAvailable: false,
  };
}

export async function readWorkBoard(
  db: SqlDatabase,
  workspaceId: string,
  projectIds: string[],
  nowIso: string,
  access: TaskAccessContext,
): Promise<WorkBoardProjection> {
  if (!access) throw new DomainError("invalid_argument", "human board access is required");
  const board = await selectWorkBoard(db, workspaceId, projectIds, access.humanId, nowIso, access);
  return { ...board, role: board.role!, authorizationEpoch: board.authorizationEpoch! };
}

export async function buildProjectLanes(
  db: SqlDatabase,
  workspaceId: string,
  projectIds: string[],
  access?: TaskAccessContext,
): Promise<ProjectLane[]> {
  return (await selectWorkBoard(db, workspaceId, projectIds, access?.humanId ?? null, null, access))
    .lanes;
}

export async function buildNeedsNowDeck(
  db: SqlDatabase,
  workspaceId: string,
  humanId: string,
  projectIds: string[],
  nowIso: string,
  access?: TaskAccessContext,
): Promise<AttentionDeckItem[]> {
  return (await selectWorkBoard(db, workspaceId, projectIds, humanId, nowIso, access)).needsNow;
}

export function unavailableAgentWorkCopy(): string {
  return "Agent work unavailable";
}

export function mcpActivityCopy(providerLabel: string | undefined, humanName: string): string {
  const provider = providerLabel ?? "MCP client";
  return `${provider} client via ${humanName}'s grant · MCP activity recent`;
}

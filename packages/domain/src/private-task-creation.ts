// ABOUTME: Prepares direct-human private roots and inherited descendants without production registration.
// ABOUTME: Preserves actual authorship and minimal receipts with current-authority atomic Hub guards.

import { createHash } from "node:crypto";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { isUlid } from "./ids.js";
import { canonicalLaunchJson } from "./launch-state.js";
import {
  allPublicAuthority,
  capturePublicBusinessAuthority,
  publicBusinessCommand,
  publicBusinessSelection,
  publicProjectAuthorityPredicate,
  publicTaskAuthorityPredicate,
  publicTaskRowAuthorityPredicate,
  type PublicBusinessAuthority,
  type PublicBusinessSelection,
} from "./public-business.js";
import { taskPrivacyRootExpression } from "./task-access.js";
import {
  getTask,
  persistTaskCreation,
  prepareTaskCreation,
  type CreateTaskInput,
} from "./work-commands.js";

export interface PrivateTaskCreationReceipt {
  task_id: string;
  project_id: string;
  parent_task_id: string | null;
  privacy_root_task_id: string;
}

const roles = ["owner", "member"] as const;
const fields = [
  "projectId",
  "parentTaskId",
  "title",
  "priority",
  "state",
  "dueAt",
  "nextOwnerType",
  "nextOwnerId",
  "nextActionReason",
  "punchline",
];
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length === 26 && isUlid(value);
}
function checkedInput(input: CreateTaskInput): void {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !fields.includes(key)) ||
    !validId(input.projectId) ||
    (input.parentTaskId !== undefined && !validId(input.parentTaskId))
  )
    throw new DomainError("invalid_argument", "invalid private task input");
}
function directHuman(ctx: HubContext): void {
  if (
    !validId(ctx.actorHumanId) ||
    ctx.actorDelegationId !== undefined ||
    ctx.actorRunnerId !== undefined ||
    ctx.actorSystemId !== undefined
  )
    throw new DomainError("forbidden", "direct human private creation is required");
}
function unavailable(): never {
  throw new DomainError("not_found", "task not found");
}
function creationAuthority(input: CreateTaskInput, authority: PublicBusinessAuthority) {
  if (authority.credential?.kind === "delegation") return { sql: "0", parameters: [] };
  const project = publicProjectAuthorityPredicate(authority, input.projectId, roles);
  if (input.parentTaskId === undefined) return project;
  return allPublicAuthority(
    project,
    publicTaskAuthorityPredicate(authority, input.parentTaskId, "edit", roles),
    {
      sql: `EXISTS (SELECT 1 FROM tasks AS private_parent
        WHERE private_parent.workspace_id = ? AND private_parent.project_id = ? AND private_parent.id = ?)`,
      parameters: [authority.workspaceId, input.projectId, input.parentTaskId],
    },
  );
}
function delivery(
  input: CreateTaskInput,
  result: PrivateTaskCreationReceipt,
  authority: PublicBusinessAuthority,
): PublicBusinessSelection<PrivateTaskCreationReceipt> {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.keys(result).length !== 4 ||
    Object.keys(result).some(
      (key) => !["task_id", "project_id", "parent_task_id", "privacy_root_task_id"].includes(key),
    ) ||
    !validId(result.task_id) ||
    result.project_id !== input.projectId ||
    !validId(result.privacy_root_task_id) ||
    result.parent_task_id !== (input.parentTaskId ?? null)
  )
    return publicBusinessSelection({ sql: "0", parameters: [] });
  const access = publicTaskRowAuthorityPredicate(authority, "read", "private_created", roles);
  const admission = creationAuthority(input, authority);
  // A private parent retains its root; a shared/absent parent creates a new exact-owner root.
  const lineage =
    input.parentTaskId === undefined
      ? "private_created.id = policy.task_id AND policy.owner_human_id = private_created.created_by_human_id"
      : `EXISTS (SELECT 1 FROM tasks AS private_parent
          WHERE private_parent.workspace_id = private_created.workspace_id
            AND private_parent.project_id = private_created.project_id
            AND private_parent.id = private_created.parent_task_id
            AND (( ${taskPrivacyRootExpression("private_parent")} IS NULL
              AND private_created.id = policy.task_id AND policy.owner_human_id = private_created.created_by_human_id)
              OR ${taskPrivacyRootExpression("private_parent")} = policy.task_id))`;
  return {
    sql: `SELECT 1 AS permitted FROM tasks AS private_created
      JOIN task_privacy AS policy ON policy.workspace_id = private_created.workspace_id
        AND policy.task_id = ${taskPrivacyRootExpression("private_created")}
      WHERE private_created.workspace_id = ? AND private_created.id = ?
        AND private_created.project_id = ? AND private_created.parent_task_id IS ?
        AND private_created.created_by_human_id = ? AND private_created.created_by_delegation_id IS NULL
        AND policy.task_id = ? AND (${lineage}) AND ${access.sql} AND ${admission.sql}`,
    parameters: [
      authority.workspaceId,
      result.task_id,
      input.projectId,
      input.parentTaskId ?? null,
      authority.humanId,
      result.privacy_root_task_id,
      ...access.parameters,
      ...admission.parameters,
    ],
  };
}

/** Deliberately absent from command-catalog and every public transport until full C11 activation. */
export const createPrivateTaskCommand: HubCommand<CreateTaskInput, PrivateTaskCreationReceipt> =
  publicBusinessCommand(
    {
      name: "task.private.create",
      inputFingerprint: (input) =>
        createHash("sha256")
          .update(canonicalLaunchJson(JSON.parse(JSON.stringify(input))))
          .digest("hex"),
      auditInput: (input) => ({ projectId: input.projectId, parentTaskId: input.parentTaskId }),
      auditResult: (result) => result,
      async authorize(input, ctx) {
        checkedInput(input);
        directHuman(ctx);
      },
      async run(input, ctx) {
        checkedInput(input);
        directHuman(ctx);
        const authority = await capturePublicBusinessAuthority(ctx.db, ctx);
        const parent =
          input.parentTaskId === undefined
            ? undefined
            : await getTask(ctx.db, ctx.workspaceId, input.parentTaskId, authority);
        if (input.parentTaskId !== undefined && (!parent || parent.project_id !== input.projectId))
          unavailable();
        const lineage = parent
          ? ((await ctx.db
              .prepare(
                `SELECT ${taskPrivacyRootExpression()} AS root_task_id FROM tasks AS task
                  WHERE task.workspace_id = ? AND task.project_id = ? AND task.id = ?`,
              )
              .get(ctx.workspaceId, input.projectId, parent.id)) as
              { root_task_id: string | null } | undefined)
          : undefined;
        if (parent && !lineage) unavailable();
        const task = await prepareTaskCreation(input, ctx, false, parent);
        await persistTaskCreation(ctx, task, { humanId: ctx.actorHumanId!, delegationId: null });
        const rootTaskId = lineage?.root_task_id ?? task.id;
        if (rootTaskId === task.id) {
          await ctx.db
            .prepare(
              `INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at)
                VALUES (?,?,?,?)`,
            )
            .run(ctx.workspaceId, task.id, ctx.actorHumanId!, ctx.now);
        } else {
          await ctx.db
            .prepare(
              `INSERT INTO task_privacy_inheritance (workspace_id,project_id,task_id,root_task_id,created_at)
                VALUES (?,?,?,?,?)`,
            )
            .run(ctx.workspaceId, input.projectId, task.id, rootTaskId, ctx.now);
        }
        return {
          task_id: task.id,
          project_id: input.projectId,
          parent_task_id: task.parent_task_id,
          privacy_root_task_id: rootTaskId,
        };
      },
    },
    { admission: creationAuthority, delivery },
  );

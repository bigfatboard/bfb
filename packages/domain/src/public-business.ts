// ABOUTME: Retains public transport ceilings across typed business command admission and delivery.
// ABOUTME: Command-owned SQL guards preserve staged effects, historical receipts and existing Hub semantics.

import type { SqlDatabase } from "@bfb/db";

import {
  assertEpoch,
  loadPrincipal,
  type AuthzPrincipal,
  type WorkspaceRole,
} from "./authorization.js";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { isUlid, randomUlid } from "./ids.js";
import { taskAccessPredicate, type TaskAccessAction } from "./task-access.js";

export interface PublicBusinessAuthority extends AuthzPrincipal {
  credential?:
    | { kind: "cli"; bindingId: string; scopes: string[] }
    | {
        kind: "delegation";
        delegationId: string;
        clientId: string;
        projectId: string | null;
        taskId: string | null;
        scopes: string[];
      };
}

export interface PublicAuthoritySql {
  sql: string;
  parameters: Array<string | number | null>;
}

export interface PublicBusinessSelection<TResult> extends PublicAuthoritySql {
  /** Synchronous projection of established relation masks only. */
  project?: (result: TResult, row: Record<string, unknown>) => TResult;
}

export interface PublicBusinessPolicy<TInput, TResult> {
  admission: (input: TInput, authority: PublicBusinessAuthority) => PublicAuthoritySql;
  delivery: (
    input: TInput,
    result: TResult,
    authority: PublicBusinessAuthority,
  ) => PublicBusinessSelection<TResult>;
  /** Execution-owned union branches keep all original hooks and behavior. */
  applies?: (input: TInput) => boolean;
  /** Existing owner denial envelope, not a transport-supplied policy. */
  denial?: { code: string; message: string };
  /** Context reads already perform their canonical final selection in the transport. */
  finalSelectionByTransport?: true;
}

const finalizers = new WeakMap<
  object,
  (input: unknown, result: unknown, ctx: HubContext) => Promise<unknown>
>();
const ownedBranches = new WeakMap<object, (input: unknown) => boolean>();

function unavailable(): never {
  throw new DomainError("not_found", "resource not available");
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function exactId(value: unknown): value is string {
  return typeof value === "string" && value.length === 26 && isUlid(value);
}

/** Capture at transport admission; supplied project/role/scope ceilings must not be reloaded. */
export async function capturePublicBusinessAuthority(
  db: SqlDatabase,
  ctx: Pick<
    HubContext,
    "workspaceId" | "actorHumanId" | "actorDelegationId" | "authorizationEpoch"
  >,
  retained?: AuthzPrincipal,
): Promise<PublicBusinessAuthority> {
  if (!ctx.actorHumanId) unavailable();
  const principal = retained ?? (await loadPrincipal(db, ctx.workspaceId, ctx.actorHumanId));
  if (!retained) assertEpoch(principal, ctx.authorizationEpoch);
  if (
    principal.workspaceId !== ctx.workspaceId ||
    principal.humanId !== ctx.actorHumanId ||
    principal.authorizationEpoch !== ctx.authorizationEpoch
  )
    unavailable();
  if (!ctx.actorDelegationId) return { ...principal, projectIds: [...principal.projectIds] };
  const credential = (await db
    .prepare(
      `SELECT client_id,project_id,task_id,scopes_json FROM oauth_delegations
     WHERE workspace_id = ? AND id = ? AND human_id = ? AND authorization_epoch = ?`,
    )
    .get(ctx.workspaceId, ctx.actorDelegationId, ctx.actorHumanId, ctx.authorizationEpoch)) as
    | { client_id: string; project_id: string | null; task_id: string | null; scopes_json: string }
    | undefined;
  if (!credential) unavailable();
  let scopes: unknown;
  try {
    scopes = JSON.parse(credential.scopes_json);
  } catch {
    unavailable();
  }
  if (!stringArray(scopes)) unavailable();
  return {
    ...principal,
    projectIds: [...principal.projectIds],
    credential: {
      kind: "delegation",
      delegationId: ctx.actorDelegationId,
      clientId: credential.client_id,
      projectId: credential.project_id,
      taskId: credential.task_id,
      scopes: [...scopes],
    },
  };
}

function retainedAuthority(value: unknown, ctx: HubContext): PublicBusinessAuthority {
  if (!value || typeof value !== "object" || Array.isArray(value)) unavailable();
  const authority = value as PublicBusinessAuthority;
  if (
    authority.workspaceId !== ctx.workspaceId ||
    authority.humanId !== ctx.actorHumanId ||
    authority.authorizationEpoch !== ctx.authorizationEpoch ||
    !["owner", "member", "reviewer"].includes(authority.role) ||
    !stringArray(authority.projectIds) ||
    authority.projectIds.some((id) => !exactId(id))
  )
    unavailable();
  const credential = authority.credential;
  if (ctx.actorDelegationId) {
    if (
      credential?.kind !== "delegation" ||
      credential.delegationId !== ctx.actorDelegationId ||
      typeof credential.clientId !== "string" ||
      !credential.clientId ||
      !(credential.projectId === null || exactId(credential.projectId)) ||
      !(credential.taskId === null || exactId(credential.taskId)) ||
      !stringArray(credential.scopes)
    )
      unavailable();
  } else if (
    credential &&
    (credential.kind !== "cli" || !exactId(credential.bindingId) || !stringArray(credential.scopes))
  )
    unavailable();
  // A request-local copy cannot be widened by later mutation of route state.
  return {
    ...authority,
    projectIds: [...authority.projectIds],
    ...(credential ? { credential: { ...credential, scopes: [...credential.scopes] } } : {}),
  };
}

function splitInput<TInput>(input: TInput): { input: TInput; authority?: unknown } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { input };
  const { publicAuthority, ...business } = input as Record<string, unknown>;
  return {
    input: business as TInput,
    ...(publicAuthority === undefined ? {} : { authority: publicAuthority }),
  };
}

/** Only a registered public business command receives this internal, non-business input. */
export function withPublicBusinessAuthority<TInput, TResult>(
  command: HubCommand<TInput, TResult>,
  input: TInput,
  authority: PublicBusinessAuthority,
): TInput {
  if (!ownsPublicBusinessDelivery(command, input)) return input;
  return { ...(input as object), publicAuthority: authority } as TInput;
}

export function ownsPublicBusinessDelivery(command: object, input?: unknown): boolean {
  return finalizers.has(command) && (input === undefined || ownedBranches.get(command)!(input));
}

export async function finalizePublicBusinessResult<TInput, TResult>(
  command: HubCommand<TInput, TResult>,
  input: TInput,
  result: TResult,
  ctx: HubContext,
): Promise<TResult> {
  const finalize = finalizers.get(command);
  return finalize ? ((await finalize(input, result, ctx)) as TResult) : result;
}

export function allPublicAuthority(...predicates: PublicAuthoritySql[]): PublicAuthoritySql {
  return {
    sql: predicates.map((part) => `(${part.sql})`).join(" AND ") || "1",
    parameters: predicates.flatMap((part) => part.parameters),
  };
}

export function publicBusinessSelection<TResult>(
  predicate: PublicAuthoritySql,
): PublicBusinessSelection<TResult> {
  return { sql: `SELECT 1 AS permitted WHERE ${predicate.sql}`, parameters: predicate.parameters };
}

/** Current membership and original credential/role/scope ceilings, without a fabricated task. */
export function publicMemberAuthorityPredicate(
  authority: PublicBusinessAuthority,
  roles: readonly WorkspaceRole[] = ["owner", "member", "reviewer"],
  scope: "bfb:read" | "bfb:task:write" = "bfb:task:write",
): PublicAuthoritySql {
  if (!roles.includes(authority.role)) return { sql: "0", parameters: [] };
  const credential = authority.credential;
  if (credential && !credential.scopes.includes(scope)) return { sql: "0", parameters: [] };
  const sql = `EXISTS (
    SELECT 1 FROM workspace_members AS public_member
    JOIN workspace_authorization_epochs AS public_epoch
      ON public_epoch.workspace_id = public_member.workspace_id
      AND public_epoch.human_id = public_member.human_id
      AND public_epoch.authorization_epoch = public_member.authorization_epoch
      AND public_epoch.revoked_at IS NULL
    WHERE public_member.workspace_id = ? AND public_member.human_id = ?
      AND public_member.authorization_epoch = ? AND public_member.role IN (${roles.map((role) => `'${role}'`).join(",")})
      ${credential?.kind === "cli" ? "AND public_member.role IN ('owner','member')" : ""}
  )`;
  const parameters: Array<string | number | null> = [
    authority.workspaceId,
    authority.humanId,
    authority.authorizationEpoch,
  ];
  if (!credential) return { sql, parameters };
  const safeJson = (column: string) =>
    `CASE WHEN json_valid(${column}) THEN ${column} ELSE 'null' END`;
  const safeScopes = (alias: string) => `json_type(${safeJson(`${alias}.scopes_json`)}) = 'array'
    AND NOT EXISTS (SELECT 1 FROM json_each(${safeJson(`${alias}.scopes_json`)}) WHERE type <> 'text')
    AND EXISTS (SELECT 1 FROM json_each(${safeJson(`${alias}.scopes_json`)}) WHERE type = 'text' AND value = ?)`;
  if (credential.kind === "cli")
    return {
      sql: `(${sql} AND EXISTS (SELECT 1 FROM api_key_bindings AS public_binding
      WHERE public_binding.workspace_id = ? AND public_binding.id = ?
        AND public_binding.human_id = ? AND public_binding.principal_type = 'human'
        AND public_binding.authorization_epoch = ? AND public_binding.key_hash IS NOT NULL
        AND public_binding.exchanged_at IS NOT NULL AND public_binding.revoked_at IS NULL
        AND julianday(public_binding.expires_at) > julianday('now') AND ${safeScopes("public_binding")}
        AND (public_binding.project_ids_json IS NULL OR
          (json_type(${safeJson("public_binding.project_ids_json")}) = 'array'
           AND NOT EXISTS (SELECT 1 FROM json_each(${safeJson("public_binding.project_ids_json")}) WHERE type <> 'text')))
    ))`,
      parameters: [
        ...parameters,
        authority.workspaceId,
        credential.bindingId,
        authority.humanId,
        authority.authorizationEpoch,
        scope,
      ],
    };
  return {
    sql: `(${sql} AND EXISTS (SELECT 1 FROM oauth_delegations AS public_credential
      WHERE public_credential.workspace_id = ? AND public_credential.id = ?
        AND public_credential.human_id = ? AND public_credential.authorization_epoch = ?
        AND public_credential.client_id = ? AND public_credential.project_id IS ? AND public_credential.task_id IS ?
        AND public_credential.revoked_at IS NULL AND julianday(public_credential.expires_at) > julianday('now')
        AND ${safeScopes("public_credential")}
    ))`,
    parameters: [
      ...parameters,
      authority.workspaceId,
      credential.delegationId,
      authority.humanId,
      authority.authorizationEpoch,
      credential.clientId,
      credential.projectId,
      credential.taskId,
      scope,
    ],
  };
}

/** Project metadata follows project authority and both original/current binding subsets. */
export function publicProjectAuthorityPredicate(
  authority: PublicBusinessAuthority,
  projectId: string,
  roles: readonly WorkspaceRole[] = ["owner", "member", "reviewer"],
  scope: "bfb:read" | "bfb:task:write" = "bfb:task:write",
): PublicAuthoritySql {
  const row = publicProjectRowAuthorityPredicate(authority, "public_project", roles, scope);
  return {
    sql: `EXISTS (SELECT 1 FROM projects AS public_project WHERE public_project.id = ? AND ${row.sql})`,
    parameters: [projectId, ...row.parameters],
  };
}

/** Task actions use current task policy and a captured project/credential ceiling. */
export function publicTaskAuthorityPredicate(
  authority: PublicBusinessAuthority,
  taskId: string,
  action: TaskAccessAction,
  roles: readonly WorkspaceRole[] = action === "edit"
    ? ["owner", "member"]
    : ["owner", "member", "reviewer"],
  scope: "bfb:read" | "bfb:task:write" = "bfb:task:write",
): PublicAuthoritySql {
  const row = publicTaskRowAuthorityPredicate(authority, action, "public_task", roles, scope);
  return {
    sql: `EXISTS (SELECT 1 FROM tasks AS public_task WHERE public_task.id = ? AND ${row.sql})`,
    parameters: [taskId, ...row.parameters],
  };
}

/** Explicit canonical task alias for command-owned joins; never accepts a caller SQL expression. */
export function publicTaskRowAuthorityPredicate(
  authority: PublicBusinessAuthority,
  action: TaskAccessAction,
  alias: string,
  roles: readonly WorkspaceRole[] = action === "edit"
    ? ["owner", "member"]
    : ["owner", "member", "reviewer"],
  scope: "bfb:read" | "bfb:task:write" = "bfb:task:write",
): PublicAuthoritySql {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) throw new Error("invalid public task alias");
  const member = publicMemberAuthorityPredicate(authority, roles, scope);
  const task = taskAccessPredicate(authority, action, alias);
  const credential = authority.credential;
  return allPublicAuthority(member, {
    sql: `${alias}.workspace_id = ?
      AND ${alias}.project_id IN (SELECT value FROM json_each(?) WHERE type = 'text') AND ${task.sql}
      ${
        credential?.kind === "cli"
          ? `AND EXISTS (SELECT 1 FROM api_key_bindings AS public_binding
        WHERE public_binding.workspace_id = ${alias}.workspace_id AND public_binding.id = ?
          AND (public_binding.project_ids_json IS NULL OR EXISTS (
            SELECT 1 FROM json_each(CASE WHEN json_valid(public_binding.project_ids_json) THEN public_binding.project_ids_json ELSE 'null' END)
              WHERE type = 'text' AND value = ${alias}.project_id
          )))`
          : ""
      }
      ${credential?.kind === "delegation" && credential.projectId !== null ? `AND ${alias}.project_id = ?` : ""}
      ${
        credential?.kind === "delegation" && credential.taskId !== null
          ? `AND EXISTS (
        WITH RECURSIVE public_subtree(id) AS (
          SELECT id FROM tasks WHERE workspace_id = ? AND id = ? AND project_id = ${alias}.project_id
          UNION SELECT child.id FROM tasks AS child JOIN public_subtree ON child.parent_task_id = public_subtree.id
            WHERE child.workspace_id = ? AND child.project_id = ${alias}.project_id
        ) SELECT 1 FROM public_subtree WHERE id = ${alias}.id
      )`
          : ""
      }
    `,
    parameters: [
      authority.workspaceId,
      JSON.stringify(authority.projectIds),
      ...task.parameters,
      ...(credential?.kind === "cli" ? [credential.bindingId] : []),
      ...(credential?.kind === "delegation" && credential.projectId !== null
        ? [credential.projectId]
        : []),
      ...(credential?.kind === "delegation" && credential.taskId !== null
        ? [authority.workspaceId, credential.taskId, authority.workspaceId]
        : []),
    ],
  });
}

/** Exact work-run lineage, not active/latest execution or result-state authority. */
export function publicRunAuthorityPredicate(
  authority: PublicBusinessAuthority,
  runId: string,
  action: TaskAccessAction,
  roles: readonly WorkspaceRole[] = action === "edit"
    ? ["owner", "member"]
    : ["owner", "member", "reviewer"],
  scope: "bfb:read" | "bfb:task:write" = "bfb:task:write",
): PublicAuthoritySql {
  const task = publicTaskRowAuthorityPredicate(authority, action, "public_run_task", roles, scope);
  return {
    sql: `EXISTS (SELECT 1 FROM runs AS public_run JOIN tasks AS public_run_task
      ON public_run_task.workspace_id = public_run.workspace_id AND public_run_task.id = public_run.task_id
        AND public_run_task.project_id = public_run.project_id
      WHERE public_run.workspace_id = ? AND public_run.id = ? AND public_run.purpose = 'work' AND ${task.sql})`,
    parameters: [authority.workspaceId, runId, ...task.parameters],
  };
}

export function publicProjectRowAuthorityPredicate(
  authority: PublicBusinessAuthority,
  alias: string,
  roles: readonly WorkspaceRole[] = ["owner", "member", "reviewer"],
  scope: "bfb:read" | "bfb:task:write" = "bfb:task:write",
): PublicAuthoritySql {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) throw new Error("invalid public project alias");
  const credential = authority.credential;
  return allPublicAuthority(publicMemberAuthorityPredicate(authority, roles, scope), {
    sql: `${alias}.workspace_id = ? AND ${alias}.id IN (SELECT value FROM json_each(?) WHERE type = 'text')
      AND (${alias}.access_mode = 'workspace' OR EXISTS (SELECT 1 FROM project_access AS public_grant
        WHERE public_grant.workspace_id = ${alias}.workspace_id AND public_grant.project_id = ${alias}.id AND public_grant.human_id = ?))
      ${credential?.kind === "delegation" && credential.projectId !== null ? `AND ${alias}.id = ?` : ""}
      ${
        credential?.kind === "cli"
          ? `AND EXISTS (SELECT 1 FROM api_key_bindings AS public_binding
        WHERE public_binding.workspace_id = ${alias}.workspace_id AND public_binding.id = ?
          AND (public_binding.project_ids_json IS NULL OR EXISTS (SELECT 1 FROM json_each(
            CASE WHEN json_valid(public_binding.project_ids_json) THEN public_binding.project_ids_json ELSE 'null' END)
            WHERE type = 'text' AND value = ${alias}.id)))`
          : ""
      }`,
    parameters: [
      authority.workspaceId,
      JSON.stringify(authority.projectIds),
      authority.humanId,
      ...(credential?.kind === "delegation" && credential.projectId !== null
        ? [credential.projectId]
        : []),
      ...(credential?.kind === "cli" ? [credential.bindingId] : []),
    ],
  });
}

async function selectPublicResult<TResult>(
  db: SqlDatabase,
  result: TResult,
  selection: PublicBusinessSelection<TResult>,
  denial?: { code: string; message: string },
): Promise<TResult> {
  const row = (await db.prepare(selection.sql).get(...selection.parameters)) as
    Record<string, unknown> | undefined;
  if (!row) {
    if (denial) throw new DomainError(denial.code, denial.message);
    unavailable();
  }
  return selection.project ? selection.project(result, row) : result;
}

/** Adapts only explicitly owned business commands; it neither changes nor extends the Hub interface. */
export function publicBusinessCommand<TInput, TResult>(
  base: HubCommand<TInput, TResult>,
  policy: PublicBusinessPolicy<TInput, TResult>,
): HubCommand<TInput, TResult> {
  const replayAuthorities = new WeakMap<HubContext, PublicBusinessAuthority>();
  const applies = (input: TInput) => policy.applies?.(input) ?? true;
  const clean = (input: TInput) => (applies(input) ? splitInput(input).input : input);
  const authority = async (input: TInput, ctx: HubContext) => {
    const split = splitInput(input);
    return split.authority === undefined
      ? await capturePublicBusinessAuthority(ctx.db, ctx)
      : retainedAuthority(split.authority, ctx);
  };
  const command: HubCommand<TInput, TResult> = {
    ...base,
    ...(base.authorize
      ? {
          async authorize(input: TInput, ctx: HubContext) {
            await base.authorize!(clean(input), ctx);
            if (!applies(input)) return;
            const retained = await authority(input, ctx);
            const admission = policy.admission(clean(input), retained);
            await selectPublicResult(
              ctx.db,
              null,
              publicBusinessSelection(admission),
              policy.denial,
            );
            replayAuthorities.set(ctx, retained);
          },
        }
      : {}),
    ...(base.inputFingerprint
      ? { inputFingerprint: (input: TInput) => base.inputFingerprint!(clean(input)) }
      : {}),
    auditInput: (input) => (base.auditInput ? base.auditInput(clean(input)) : clean(input)),
    ...(base.extraCursors
      ? { extraCursors: (input: TInput) => base.extraCursors!(clean(input)) }
      : {}),
    async replayResult(result, ctx, input) {
      if (!applies(input))
        return base.replayResult ? await base.replayResult(result, ctx, input) : result;
      const retained = replayAuthorities.get(ctx);
      if (!retained) unavailable();
      const projected = base.replayResult
        ? await base.replayResult(result, ctx, clean(input))
        : result;
      return selectPublicResult(
        ctx.db,
        projected,
        policy.delivery(clean(input), projected, retained),
        policy.denial,
      );
    },
    async run(input, ctx) {
      if (!applies(input)) return base.run(input, ctx);
      const retained = await authority(input, ctx);
      if (!base.authorize) {
        await selectPublicResult(
          ctx.db,
          null,
          publicBusinessSelection(policy.admission(clean(input), retained)),
          policy.denial,
        );
      }
      const result = await base.run(clean(input), ctx);
      const delivery = policy.delivery(clean(input), result, retained);
      const guardId = randomUlid();
      await ctx.db
        .prepare(
          // Keep the typed selection in its own expression tree below D1's depth limit.
          // VALUES still attempts a failing CHECK even when the selection has no rows.
          `WITH public_delivery AS MATERIALIZED (${delivery.sql})
        INSERT INTO artifact_mutation_guards (id, valid)
        VALUES (?, CASE WHEN EXISTS (SELECT 1 FROM public_delivery) THEN 1 ELSE 0 END)`,
        )
        .run(...delivery.parameters, guardId);
      await ctx.db.prepare(`DELETE FROM artifact_mutation_guards WHERE id = ?`).run(guardId);
      return result;
    },
  };
  ownedBranches.set(command, (input) => applies(input as TInput));
  finalizers.set(command, async (input, result, ctx) => {
    if (!applies(input as TInput)) return result;
    if (policy.finalSelectionByTransport) return result;
    const retained = await authority(input as TInput, ctx);
    return selectPublicResult(
      ctx.db,
      result as TResult,
      policy.delivery(clean(input as TInput), result as TResult, retained),
      policy.denial,
    );
  });
  return command;
}

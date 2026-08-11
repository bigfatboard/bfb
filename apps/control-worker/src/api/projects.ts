// ABOUTME: Serves grant-scoped project, policy, repository-config, and agent-profile APIs.
// ABOUTME: Every mutation uses a bounded browser body and the workspace command lane.

import { createAuthorizationContext, type SqlDatabase } from "@bfb/db";
import {
  changeProjectAccessCommand,
  createAgentProfileCommand,
  createProjectCommand,
  DomainError,
  getProject,
  getProjectPolicy,
  getWorkspacePolicy,
  listAgentProfilesPage,
  listProjectsPage,
  listVersionRows,
  loadPrincipal,
  reportRepositoryConfigCommand,
  updateAgentProfileCommand,
  updateProjectCommand,
  updateProjectPolicyCommand,
  updateWorkspacePolicyCommand,
  type AuthzPrincipal,
  type PolicySettings,
  type Provider,
} from "@bfb/domain";

import type { BrowserPrincipal } from "../auth/session.js";
import type { Jurisdiction } from "../env.js";
import { executeWorkspaceCommand } from "../hub-client.js";
import { readBoundedJson } from "./request.js";

const BODY_LIMIT = 32_768;

export interface ProjectApiDeps {
  db: SqlDatabase;
  principal: BrowserPrincipal;
  workspaceId: string;
  now: string;
  jurisdiction: Jurisdiction;
  workspaceHubNs?: DurableObjectNamespace | undefined;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function objectBody(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("invalid_argument", "request body must be an object");
  }
  const body = value as Record<string, unknown>;
  const keys = new Set(allowed);
  if (Object.keys(body).some((key) => !keys.has(key))) {
    throw new DomainError("invalid_argument", "request body contains an unsupported field");
  }
  return body;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value) {
    throw new DomainError("invalid_argument", `${key} is required`);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new DomainError("invalid_argument", `${key} must be a string`);
  }
  return value;
}

function requiredVersion(body: Record<string, unknown>): number {
  const value = body.expected_version;
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new DomainError("invalid_argument", "expected_version is required");
  }
  return Number(value);
}

function requestId(body: Record<string, unknown>): string {
  const value = requiredString(body, "request_id");
  if (value.length > 128) {
    throw new DomainError("invalid_argument", "request_id is invalid");
  }
  return value;
}

function policy(body: Record<string, unknown>): PolicySettings {
  const providers = body.allowed_providers;
  if (!Array.isArray(providers) || providers.some((provider) => typeof provider !== "string")) {
    throw new DomainError("invalid_argument", "allowed_providers must be an array");
  }
  for (const key of ["allow_agent_root_propose", "allow_pass_to_agent", "allow_run_overrides"]) {
    if (typeof body[key] !== "boolean") {
      throw new DomainError("invalid_argument", `${key} must be boolean`);
    }
  }
  return {
    allowedProviders: providers as Provider[],
    allowAgentRootPropose: body.allow_agent_root_propose as boolean,
    allowPassToAgent: body.allow_pass_to_agent as boolean,
    allowRunOverrides: body.allow_run_overrides as boolean,
  };
}

function page(url: URL): { limit?: number; cursor?: string } {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
    throw new DomainError("invalid_argument", "limit is invalid");
  }
  const cursor = url.searchParams.get("cursor") ?? undefined;
  return { ...(limit === undefined ? {} : { limit }), ...(cursor ? { cursor } : {}) };
}

function versionPage(url: URL): { limit?: number; cursor?: number } {
  const base = page(url);
  if (base.cursor === undefined) {
    return base.limit === undefined ? {} : { limit: base.limit };
  }
  const cursor = Number(base.cursor);
  if (!Number.isSafeInteger(cursor) || cursor < 1) {
    throw new DomainError("invalid_argument", "cursor is invalid");
  }
  return { ...(base.limit === undefined ? {} : { limit: base.limit }), cursor };
}

function assertProject(principal: AuthzPrincipal, projectId: string): void {
  if (!principal.projectIds.includes(projectId)) {
    throw new DomainError("not_found", "project not found");
  }
}

function outcomeResponse(outcome: { ok: boolean; error?: { code: string } }): Response {
  if (outcome.ok) {
    return json(outcome);
  }
  const code = outcome.error?.code ?? "command_failed";
  const status =
    code === "forbidden" || code === "unauthenticated"
      ? 403
      : code === "not_found"
        ? 404
        : code === "stale_version" || code === "already_exists"
          ? 409
          : 400;
  return json(outcome, status);
}

async function commandBody(
  request: Request,
  allowed: readonly string[],
): Promise<Record<string, unknown>> {
  return objectBody(await readBoundedJson(request, BODY_LIMIT), allowed);
}

export async function handleProjectApi(request: Request, deps: ProjectApiDeps): Promise<Response> {
  const url = new URL(request.url);
  const base = `/api/v1/workspaces/${deps.workspaceId}`;
  const principal = await loadPrincipal(deps.db, deps.workspaceId, deps.principal.humanId);
  const hub = {
    db: deps.db,
    authorization: createAuthorizationContext({
      workspaceId: deps.workspaceId,
      principalId: deps.principal.humanId,
      authorizationEpoch: principal.authorizationEpoch,
      jurisdiction: deps.jurisdiction,
    }),
    workspaceHubNs: deps.workspaceHubNs,
  };
  const execute = async <TInput, TResult>(
    command: Parameters<typeof executeWorkspaceCommand<TInput, TResult>>[1],
    idempotencyKey: string,
    input: TInput,
  ) =>
    executeWorkspaceCommand(hub, command, {
      workspaceId: deps.workspaceId,
      idempotencyKey,
      authorizationEpoch: principal.authorizationEpoch,
      actorHumanId: deps.principal.humanId,
      now: deps.now,
      input,
    });

  if (url.pathname === `${base}/projects` && request.method === "GET") {
    return json(await listProjectsPage(deps.db, principal, page(url)));
  }
  if (url.pathname === `${base}/projects` && request.method === "POST") {
    const body = await commandBody(request, [
      "name",
      "slug",
      "tint",
      "access_mode",
      "repository_host",
      "hosted_repository_id",
      "repository_subpath",
      "request_id",
    ]);
    const outcome = await execute(createProjectCommand, requestId(body), {
      name: requiredString(body, "name"),
      slug: requiredString(body, "slug"),
      tint: requiredString(body, "tint"),
      accessMode: requiredString(body, "access_mode") as "workspace" | "restricted",
      repositoryHost: requiredString(body, "repository_host"),
      hostedRepositoryId: requiredString(body, "hosted_repository_id"),
      repositorySubpath: requiredString(body, "repository_subpath"),
    });
    return outcomeResponse(outcome);
  }

  if (url.pathname === `${base}/workspace-policy` && request.method === "GET") {
    return json({ policy: await getWorkspacePolicy(deps.db, deps.workspaceId) });
  }
  if (url.pathname === `${base}/workspace-policy` && request.method === "PUT") {
    const body = await commandBody(request, [
      "expected_version",
      "allowed_providers",
      "allow_agent_root_propose",
      "allow_pass_to_agent",
      "allow_run_overrides",
      "request_id",
    ]);
    const outcome = await execute(updateWorkspacePolicyCommand, requestId(body), {
      ...policy(body),
      expectedVersion: requiredVersion(body),
    });
    return outcomeResponse(outcome);
  }
  if (url.pathname === `${base}/workspace-policy/versions` && request.method === "GET") {
    return json(
      await listVersionRows(
        deps.db,
        "workspace_policy_versions",
        deps.workspaceId,
        {},
        versionPage(url),
      ),
    );
  }

  if (url.pathname === `${base}/agent-profiles` && request.method === "GET") {
    return json(await listAgentProfilesPage(deps.db, deps.workspaceId, page(url)));
  }
  if (url.pathname === `${base}/agent-profiles` && request.method === "POST") {
    const body = await commandBody(request, [
      "name",
      "provider",
      "model",
      "execution_mode",
      "harness_mode",
      "request_id",
    ]);
    const model = optionalString(body, "model");
    const outcome = await execute(createAgentProfileCommand, requestId(body), {
      name: requiredString(body, "name"),
      provider: requiredString(body, "provider") as Provider,
      ...(model === undefined ? {} : { model }),
      executionMode: requiredString(body, "execution_mode") as "interactive" | "headless",
      harnessMode: requiredString(body, "harness_mode") as "restricted" | "standard",
    });
    return outcomeResponse(outcome);
  }

  const profile = url.pathname.match(new RegExp(`^${base}/agent-profiles/([^/]+)(/versions)?$`));
  if (profile) {
    const profileId = profile[1] ?? "";
    if (profile[2] === "/versions" && request.method === "GET") {
      return json(
        await listVersionRows(
          deps.db,
          "agent_profile_versions",
          deps.workspaceId,
          { profileId },
          versionPage(url),
        ),
      );
    }
    if (!profile[2] && request.method === "PATCH") {
      const body = await commandBody(request, [
        "expected_version",
        "name",
        "provider",
        "model",
        "execution_mode",
        "harness_mode",
        "request_id",
      ]);
      const model = optionalString(body, "model");
      const outcome = await execute(updateAgentProfileCommand, requestId(body), {
        profileId,
        expectedVersion: requiredVersion(body),
        name: requiredString(body, "name"),
        provider: requiredString(body, "provider") as Provider,
        ...(model === undefined ? {} : { model }),
        executionMode: requiredString(body, "execution_mode") as "interactive" | "headless",
        harnessMode: requiredString(body, "harness_mode") as "restricted" | "standard",
      });
      return outcomeResponse(outcome);
    }
  }

  const project = url.pathname.match(
    new RegExp(
      `^${base}/projects/([^/]+)(?:/(access/([^/]+)|policy(?:/versions)?|repository-config(?:/versions)?))?$`,
    ),
  );
  if (!project) {
    return json({ error: "not_found" }, 404);
  }
  const projectId = project[1] ?? "";
  const suffix = project[2] ?? "";
  assertProject(principal, projectId);

  if (!suffix && request.method === "GET") {
    const record = await getProject(deps.db, deps.workspaceId, projectId);
    return record ? json({ project: record }) : json({ error: "not_found" }, 404);
  }
  if (!suffix && request.method === "PATCH") {
    const body = await commandBody(request, [
      "expected_version",
      "name",
      "slug",
      "tint",
      "access_mode",
      "request_id",
    ]);
    const name = optionalString(body, "name");
    const slug = optionalString(body, "slug");
    const tint = optionalString(body, "tint");
    const accessMode = optionalString(body, "access_mode") as
      "workspace" | "restricted" | undefined;
    const outcome = await execute(updateProjectCommand, requestId(body), {
      projectId,
      expectedVersion: requiredVersion(body),
      ...(name === undefined ? {} : { name }),
      ...(slug === undefined ? {} : { slug }),
      ...(tint === undefined ? {} : { tint }),
      ...(accessMode === undefined ? {} : { accessMode }),
    });
    return outcomeResponse(outcome);
  }
  if (suffix.startsWith("access/") && (request.method === "PUT" || request.method === "DELETE")) {
    const body = await commandBody(request, ["request_id"]);
    const outcome = await execute(changeProjectAccessCommand, requestId(body), {
      projectId,
      humanId: project[3] ?? "",
      grant: request.method === "PUT",
    });
    return outcomeResponse(outcome);
  }
  if (suffix === "policy" && request.method === "GET") {
    return json({ policy: await getProjectPolicy(deps.db, deps.workspaceId, projectId) });
  }
  if (suffix === "policy" && request.method === "PUT") {
    const body = await commandBody(request, [
      "expected_version",
      "allowed_providers",
      "allow_agent_root_propose",
      "allow_pass_to_agent",
      "allow_run_overrides",
      "request_id",
    ]);
    const outcome = await execute(updateProjectPolicyCommand, requestId(body), {
      projectId,
      ...policy(body),
      expectedVersion: requiredVersion(body),
    });
    return outcomeResponse(outcome);
  }
  if (suffix === "policy/versions" && request.method === "GET") {
    return json(
      await listVersionRows(
        deps.db,
        "project_policy_versions",
        deps.workspaceId,
        { projectId },
        versionPage(url),
      ),
    );
  }
  if (suffix === "repository-config" && request.method === "GET") {
    const config = await deps.db
      .prepare(
        `SELECT canonical_json, content_hash, resource_version
         FROM repository_configs WHERE workspace_id = ? AND project_id = ?`,
      )
      .get(deps.workspaceId, projectId);
    return config ? json({ config }) : json({ error: "not_found" }, 404);
  }
  if (suffix === "repository-config" && request.method === "PUT") {
    const body = await commandBody(request, [
      "expected_version",
      "document",
      "content_hash",
      "request_id",
    ]);
    const outcome = await execute(reportRepositoryConfigCommand, requestId(body), {
      projectId,
      expectedVersion: requiredVersion(body),
      document: body.document,
      contentHash: requiredString(body, "content_hash"),
    });
    return outcomeResponse(outcome);
  }
  if (suffix === "repository-config/versions" && request.method === "GET") {
    return json(
      await listVersionRows(
        deps.db,
        "repository_config_versions",
        deps.workspaceId,
        { projectId },
        versionPage(url),
      ),
    );
  }
  return json({ error: "not_found" }, 404);
}

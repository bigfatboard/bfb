// ABOUTME: Owns canonical project identity, project grants, and immutable configuration versions.
// ABOUTME: WorkspaceHub commands enforce role, grant, policy-tightening, and stale-version boundaries.

import { createHash } from "node:crypto";

import type { SqlDatabase } from "@bfb/db";

import {
  assertEpoch,
  assertProjectAccess,
  assertRole,
  loadPrincipal,
  type AuthzPrincipal,
} from "./authorization.js";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { isUlid, randomUlid } from "./ids.js";

export const PROVIDERS = ["claude", "codex", "grok", "fake"] as const;
export type Provider = (typeof PROVIDERS)[number];
export type ProjectAccessMode = "workspace" | "restricted";

export interface PolicySettings {
  allowedProviders: Provider[];
  allowAgentRootPropose: boolean;
  allowPassToAgent: boolean;
  allowRunOverrides: boolean;
}

export interface ProjectRecord {
  id: string;
  name: string;
  slug: string;
  tint: string;
  access_mode: ProjectAccessMode;
  repository_host: string;
  hosted_repository_id: string;
  repository_subpath: string;
  resource_version: number;
}

export interface AgentProfileRecord {
  id: string;
  name: string;
  provider: Provider;
  model: string | null;
  execution_mode: "interactive" | "headless";
  harness_mode: "restricted" | "standard";
  resource_version: number;
}

interface PolicyRow {
  allowed_providers_json: string;
  allow_agent_root_propose: number;
  allow_pass_to_agent: number;
  allow_run_overrides: number;
  resource_version: number;
}

const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const HOSTED_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TINT_PATTERN = /^#[0-9A-F]{6}$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function boundedText(value: string, name: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || [...normalized].length > maximum || containsControlCharacter(normalized)) {
    throw new DomainError("invalid_argument", `${name} is invalid`);
  }
  return normalized;
}

export function normalizeRepositoryHost(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!HOST_PATTERN.test(normalized) || normalized.includes("..")) {
    throw new DomainError("invalid_repository", "repository host is invalid");
  }
  return normalized;
}

export function normalizeHostedRepositoryId(value: string): string {
  const normalized = value.trim();
  if (!HOSTED_ID_PATTERN.test(normalized)) {
    throw new DomainError("invalid_repository", "hosted repository id is invalid");
  }
  return normalized;
}

export function normalizeRepositorySubpath(value: string): string {
  const normalized = value.trim();
  if (normalized === ".") {
    return normalized;
  }
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.startsWith("~") ||
    normalized.includes("\\") ||
    normalized.includes(":") ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        [...segment].length > 128 ||
        containsControlCharacter(segment),
    )
  ) {
    throw new DomainError("invalid_repository", "repository subpath is invalid");
  }
  return segments.join("/");
}

function normalizeSlug(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SLUG_PATTERN.test(normalized)) {
    throw new DomainError("invalid_argument", "project slug is invalid");
  }
  return normalized;
}

function normalizeTint(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!TINT_PATTERN.test(normalized)) {
    throw new DomainError("invalid_argument", "project tint is invalid");
  }
  return normalized;
}

function normalizeProviders(values: readonly string[]): Provider[] {
  if (!Array.isArray(values) || values.some((provider) => typeof provider !== "string")) {
    throw new DomainError("invalid_policy", "provider policy is invalid");
  }
  const providers = [...new Set(values)].sort();
  if (providers.some((provider) => !PROVIDERS.includes(provider as Provider))) {
    throw new DomainError("invalid_policy", "provider policy is invalid");
  }
  return providers as Provider[];
}

function policyFromRow(row: PolicyRow): PolicySettings {
  const parsed = JSON.parse(row.allowed_providers_json) as unknown;
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new DomainError("invalid_policy", "stored provider policy is invalid");
  }
  return {
    allowedProviders: normalizeProviders(parsed),
    allowAgentRootPropose: row.allow_agent_root_propose === 1,
    allowPassToAgent: row.allow_pass_to_agent === 1,
    allowRunOverrides: row.allow_run_overrides === 1,
  };
}

function policyValues(policy: PolicySettings): [string, number, number, number] {
  return [
    JSON.stringify(normalizeProviders(policy.allowedProviders)),
    policy.allowAgentRootPropose ? 1 : 0,
    policy.allowPassToAgent ? 1 : 0,
    policy.allowRunOverrides ? 1 : 0,
  ];
}

function normalizePolicySettings(input: PolicySettings): PolicySettings {
  if (
    typeof input.allowAgentRootPropose !== "boolean" ||
    typeof input.allowPassToAgent !== "boolean" ||
    typeof input.allowRunOverrides !== "boolean"
  ) {
    throw new DomainError("invalid_policy", "policy flags must be boolean");
  }
  return {
    allowedProviders: normalizeProviders(input.allowedProviders),
    allowAgentRootPropose: input.allowAgentRootPropose,
    allowPassToAgent: input.allowPassToAgent,
    allowRunOverrides: input.allowRunOverrides,
  };
}

export function assertPolicyTightens(parent: PolicySettings, child: PolicySettings): void {
  const parentProviders = new Set(parent.allowedProviders);
  if (child.allowedProviders.some((provider) => !parentProviders.has(provider))) {
    throw new DomainError("policy_widening", "provider policy cannot widen its parent");
  }
  if (
    (!parent.allowAgentRootPropose && child.allowAgentRootPropose) ||
    (!parent.allowPassToAgent && child.allowPassToAgent) ||
    (!parent.allowRunOverrides && child.allowRunOverrides)
  ) {
    throw new DomainError("policy_widening", "repository policy cannot widen its parent");
  }
}

export function evaluateEffectivePolicy(input: {
  workspace: PolicySettings;
  project: PolicySettings;
  repository: PolicySettings;
  profileProvider: Provider;
  runnerProviders: readonly Provider[];
  overrideProvider?: Provider;
}): { provider: Provider; allowAgentRootPropose: boolean; allowPassToAgent: boolean } {
  assertPolicyTightens(input.workspace, input.project);
  assertPolicyTightens(input.project, input.repository);
  const runnerProviders = new Set(input.runnerProviders);
  const available = input.repository.allowedProviders.filter((provider) =>
    runnerProviders.has(provider),
  );
  const provider = input.overrideProvider ?? input.profileProvider;
  if (!available.includes(provider)) {
    throw new DomainError("provider_forbidden", "provider is not available under effective policy");
  }
  if (input.overrideProvider && !input.repository.allowRunOverrides) {
    throw new DomainError("override_forbidden", "run overrides are disabled");
  }
  return {
    provider,
    allowAgentRootPropose:
      input.workspace.allowAgentRootPropose &&
      input.project.allowAgentRootPropose &&
      input.repository.allowAgentRootPropose,
    allowPassToAgent:
      input.workspace.allowPassToAgent &&
      input.project.allowPassToAgent &&
      input.repository.allowPassToAgent,
  };
}

async function requireOwner(ctx: HubContext): Promise<AuthzPrincipal> {
  if (!ctx.actorHumanId) {
    throw new DomainError("unauthenticated", "human actor required");
  }
  const principal = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
  assertEpoch(principal, ctx.authorizationEpoch);
  assertRole(principal, ["owner"]);
  return principal;
}

async function workspacePolicy(db: SqlDatabase, workspaceId: string): Promise<PolicyRow> {
  const row = (await db
    .prepare(`SELECT * FROM workspace_policies WHERE workspace_id = ?`)
    .get(workspaceId)) as PolicyRow | undefined;
  if (!row) {
    throw new DomainError("not_found", "workspace policy not found");
  }
  return row;
}

async function projectPolicy(
  db: SqlDatabase,
  workspaceId: string,
  projectId: string,
): Promise<PolicyRow> {
  const row = (await db
    .prepare(`SELECT * FROM project_policies WHERE workspace_id = ? AND project_id = ?`)
    .get(workspaceId, projectId)) as PolicyRow | undefined;
  if (!row) {
    throw new DomainError("not_found", "project policy not found");
  }
  return row;
}

async function projectForPrincipal(
  db: SqlDatabase,
  principal: AuthzPrincipal,
  projectId: string,
): Promise<ProjectRecord> {
  assertProjectAccess(principal, projectId);
  const project = await getProject(db, principal.workspaceId, projectId);
  if (!project) {
    throw new DomainError("not_found", "project not found");
  }
  return project;
}

async function authorizationEpoch(
  db: SqlDatabase,
  workspaceId: string,
  humanId: string,
): Promise<number> {
  const row = (await db
    .prepare(
      `SELECT membership.authorization_epoch
       FROM workspace_members AS membership
       JOIN workspace_authorization_epochs AS epoch
         ON epoch.workspace_id = membership.workspace_id
        AND epoch.human_id = membership.human_id
        AND epoch.authorization_epoch = membership.authorization_epoch
       WHERE membership.workspace_id = ? AND membership.human_id = ?
         AND epoch.revoked_at IS NULL`,
    )
    .get(workspaceId, humanId)) as { authorization_epoch: number } | undefined;
  if (!row) {
    throw new DomainError("not_found", "member not found");
  }
  return row.authorization_epoch;
}

async function writeAuthorizationEpoch(
  db: SqlDatabase,
  workspaceId: string,
  humanId: string,
  current: number,
  now: string,
): Promise<number> {
  const next = current + 1;
  await db
    .prepare(
      `UPDATE workspace_members SET authorization_epoch = ?
       WHERE workspace_id = ? AND human_id = ? AND authorization_epoch = ?`,
    )
    .run(next, workspaceId, humanId, current);
  await db
    .prepare(
      `UPDATE workspace_authorization_epochs
       SET authorization_epoch = ?, updated_at = ?
       WHERE workspace_id = ? AND human_id = ?
         AND authorization_epoch = ? AND revoked_at IS NULL`,
    )
    .run(next, now, workspaceId, humanId, current);
  return next;
}

export interface CreateProjectInput {
  name: string;
  slug: string;
  tint: string;
  accessMode: ProjectAccessMode;
  repositoryHost: string;
  hostedRepositoryId: string;
  repositorySubpath: string;
}

export const createProjectCommand: HubCommand<CreateProjectInput, ProjectRecord> = {
  name: "project.create",
  async run(input, ctx) {
    const principal = await requireOwner(ctx);
    const name = boundedText(input.name, "project name", 128);
    const slug = normalizeSlug(input.slug);
    const tint = normalizeTint(input.tint);
    const repositoryHost = normalizeRepositoryHost(input.repositoryHost);
    const hostedRepositoryId = normalizeHostedRepositoryId(input.hostedRepositoryId);
    const repositorySubpath = normalizeRepositorySubpath(input.repositorySubpath);
    if (input.accessMode !== "workspace" && input.accessMode !== "restricted") {
      throw new DomainError("invalid_argument", "project access mode is invalid");
    }
    const duplicate = await ctx.db
      .prepare(
        `SELECT id FROM projects
         WHERE workspace_id = ? AND (
           slug = ? OR
           (repository_host = ? AND hosted_repository_id = ? AND repository_subpath = ?)
         )`,
      )
      .get(ctx.workspaceId, slug, repositoryHost, hostedRepositoryId, repositorySubpath);
    if (duplicate) {
      throw new DomainError("already_exists", "project identity already exists");
    }
    const id = randomUlid();
    await ctx.db
      .prepare(
        `INSERT INTO projects
         (workspace_id, id, name, slug, tint, resource_version, created_at,
          access_mode, repository_host, hosted_repository_id, repository_subpath)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        id,
        name,
        slug,
        tint,
        ctx.now,
        input.accessMode,
        repositoryHost,
        hostedRepositoryId,
        repositorySubpath,
      );
    await ctx.db
      .prepare(`INSERT INTO project_access (workspace_id, project_id, human_id) VALUES (?, ?, ?)`)
      .run(ctx.workspaceId, id, principal.humanId);
    return {
      id,
      name,
      slug,
      tint,
      access_mode: input.accessMode,
      repository_host: repositoryHost,
      hosted_repository_id: hostedRepositoryId,
      repository_subpath: repositorySubpath,
      resource_version: 1,
    };
  },
};

export interface UpdateProjectInput {
  projectId: string;
  expectedVersion: number;
  name?: string;
  slug?: string;
  tint?: string;
  accessMode?: ProjectAccessMode;
}

export const updateProjectCommand: HubCommand<UpdateProjectInput, ProjectRecord> = {
  name: "project.update",
  async run(input, ctx) {
    const principal = await requireOwner(ctx);
    const project = await projectForPrincipal(ctx.db, principal, input.projectId);
    if (project.resource_version !== input.expectedVersion) {
      throw new DomainError("stale_version", "project version conflict");
    }
    const name =
      input.name === undefined ? project.name : boundedText(input.name, "project name", 128);
    const slug = input.slug === undefined ? project.slug : normalizeSlug(input.slug);
    const tint = input.tint === undefined ? project.tint : normalizeTint(input.tint);
    const accessMode = input.accessMode ?? project.access_mode;
    if (accessMode !== "workspace" && accessMode !== "restricted") {
      throw new DomainError("invalid_argument", "project access mode is invalid");
    }
    const members =
      accessMode === project.access_mode
        ? []
        : ((await ctx.db
            .prepare(
              `SELECT membership.human_id, membership.authorization_epoch
               FROM workspace_members AS membership
               JOIN workspace_authorization_epochs AS epoch
                 ON epoch.workspace_id = membership.workspace_id
                AND epoch.human_id = membership.human_id
                AND epoch.authorization_epoch = membership.authorization_epoch
               WHERE membership.workspace_id = ? AND epoch.revoked_at IS NULL`,
            )
            .all(ctx.workspaceId)) as Array<{ human_id: string; authorization_epoch: number }>);
    const nextVersion = project.resource_version + 1;
    await ctx.db
      .prepare(
        `UPDATE projects
         SET name = ?, slug = ?, tint = ?, access_mode = ?, resource_version = ?
         WHERE workspace_id = ? AND id = ? AND resource_version = ?`,
      )
      .run(
        name,
        slug,
        tint,
        accessMode,
        nextVersion,
        ctx.workspaceId,
        project.id,
        input.expectedVersion,
      );
    for (const member of members) {
      await writeAuthorizationEpoch(
        ctx.db,
        ctx.workspaceId,
        member.human_id,
        member.authorization_epoch,
        ctx.now,
      );
    }
    return { ...project, name, slug, tint, access_mode: accessMode, resource_version: nextVersion };
  },
};

export interface ChangeProjectAccessInput {
  projectId: string;
  humanId: string;
  grant: boolean;
}

export const changeProjectAccessCommand: HubCommand<
  ChangeProjectAccessInput,
  { projectId: string; humanId: string; granted: boolean; authorizationEpoch: number }
> = {
  name: "project.access.change",
  async run(input, ctx) {
    const principal = await requireOwner(ctx);
    const project = await projectForPrincipal(ctx.db, principal, input.projectId);
    if (typeof input.grant !== "boolean") {
      throw new DomainError("invalid_argument", "project grant flag must be boolean");
    }
    if (!isUlid(input.humanId)) {
      throw new DomainError("invalid_argument", "human id is invalid");
    }
    const currentEpoch = await authorizationEpoch(ctx.db, ctx.workspaceId, input.humanId);
    const existing = await ctx.db
      .prepare(
        `SELECT 1 FROM project_access
         WHERE workspace_id = ? AND project_id = ? AND human_id = ?`,
      )
      .get(ctx.workspaceId, project.id, input.humanId);
    if (input.grant && existing) {
      throw new DomainError("already_exists", "project grant already exists");
    }
    if (!input.grant && !existing) {
      throw new DomainError("not_found", "project grant not found");
    }
    if (!input.grant && project.access_mode === "workspace") {
      throw new DomainError("invalid_access_mode", "workspace-visible project does not use grants");
    }
    if (!input.grant) {
      const target = (await ctx.db
        .prepare(`SELECT role FROM workspace_members WHERE workspace_id = ? AND human_id = ?`)
        .get(ctx.workspaceId, input.humanId)) as { role: string };
      if (target.role === "owner") {
        const owners = (await ctx.db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM project_access AS access
             JOIN workspace_members AS membership
               ON membership.workspace_id = access.workspace_id
              AND membership.human_id = access.human_id
             WHERE access.workspace_id = ? AND access.project_id = ?
               AND membership.role = 'owner'`,
          )
          .get(ctx.workspaceId, project.id)) as { count: number };
        if (owners.count <= 1) {
          throw new DomainError("final_project_owner", "restricted project needs an owner grant");
        }
      }
    }
    if (input.grant) {
      await ctx.db
        .prepare(`INSERT INTO project_access (workspace_id, project_id, human_id) VALUES (?, ?, ?)`)
        .run(ctx.workspaceId, project.id, input.humanId);
    } else {
      await ctx.db
        .prepare(
          `DELETE FROM project_access WHERE workspace_id = ? AND project_id = ? AND human_id = ?`,
        )
        .run(ctx.workspaceId, project.id, input.humanId);
    }
    const nextEpoch = await writeAuthorizationEpoch(
      ctx.db,
      ctx.workspaceId,
      input.humanId,
      currentEpoch,
      ctx.now,
    );
    return {
      projectId: project.id,
      humanId: input.humanId,
      granted: input.grant,
      authorizationEpoch: nextEpoch,
    };
  },
};

export interface UpdatePolicyInput extends PolicySettings {
  expectedVersion: number;
}

export const updateWorkspacePolicyCommand: HubCommand<
  UpdatePolicyInput,
  PolicySettings & { resourceVersion: number }
> = {
  name: "workspace.policy.update",
  async run(input, ctx) {
    const principal = await requireOwner(ctx);
    const current = await workspacePolicy(ctx.db, ctx.workspaceId);
    if (current.resource_version !== input.expectedVersion) {
      throw new DomainError("stale_version", "workspace policy version conflict");
    }
    const settings = normalizePolicySettings(input);
    const next = current.resource_version + 1;
    const [providers, rootPropose, passToAgent, runOverrides] = policyValues(settings);
    await ctx.db
      .prepare(
        `UPDATE workspace_policies
         SET allowed_providers_json = ?, allow_agent_root_propose = ?,
             allow_pass_to_agent = ?, allow_run_overrides = ?, resource_version = ?
         WHERE workspace_id = ? AND resource_version = ?`,
      )
      .run(
        providers,
        rootPropose,
        passToAgent,
        runOverrides,
        next,
        ctx.workspaceId,
        input.expectedVersion,
      );
    await ctx.db
      .prepare(
        `INSERT INTO workspace_policy_versions
         (workspace_id, version, allowed_providers_json, allow_agent_root_propose,
          allow_pass_to_agent, allow_run_overrides, created_by_human_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        next,
        providers,
        rootPropose,
        passToAgent,
        runOverrides,
        principal.humanId,
        ctx.now,
      );
    return { ...settings, resourceVersion: next };
  },
};

export interface UpdateProjectPolicyInput extends UpdatePolicyInput {
  projectId: string;
}

export const updateProjectPolicyCommand: HubCommand<
  UpdateProjectPolicyInput,
  PolicySettings & { projectId: string; resourceVersion: number }
> = {
  name: "project.policy.update",
  async run(input, ctx) {
    const principal = await requireOwner(ctx);
    await projectForPrincipal(ctx.db, principal, input.projectId);
    const ceiling = await workspacePolicy(ctx.db, ctx.workspaceId);
    const current = await projectPolicy(ctx.db, ctx.workspaceId, input.projectId);
    if (current.resource_version !== input.expectedVersion) {
      throw new DomainError("stale_version", "project policy version conflict");
    }
    const settings = normalizePolicySettings(input);
    assertPolicyTightens(policyFromRow(ceiling), settings);
    const next = current.resource_version + 1;
    const [providers, rootPropose, passToAgent, runOverrides] = policyValues(settings);
    await ctx.db
      .prepare(
        `UPDATE project_policies
         SET allowed_providers_json = ?, allow_agent_root_propose = ?,
             allow_pass_to_agent = ?, allow_run_overrides = ?, resource_version = ?
         WHERE workspace_id = ? AND project_id = ? AND resource_version = ?`,
      )
      .run(
        providers,
        rootPropose,
        passToAgent,
        runOverrides,
        next,
        ctx.workspaceId,
        input.projectId,
        input.expectedVersion,
      );
    await ctx.db
      .prepare(
        `INSERT INTO project_policy_versions
         (workspace_id, project_id, version, allowed_providers_json,
          allow_agent_root_propose, allow_pass_to_agent, allow_run_overrides,
          created_by_human_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        input.projectId,
        next,
        providers,
        rootPropose,
        passToAgent,
        runOverrides,
        principal.humanId,
        ctx.now,
      );
    return { ...settings, projectId: input.projectId, resourceVersion: next };
  },
};

type RepositoryConfigDocument = Partial<{
  allowed_providers: Provider[];
  allow_agent_root_propose: boolean;
  allow_pass_to_agent: boolean;
  allow_run_overrides: boolean;
}>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizeRepositoryConfig(
  document: unknown,
  parent: PolicySettings,
): { canonical: string; settings: PolicySettings } {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new DomainError("invalid_config", "repository config must be an object");
  }
  const allowedKeys = new Set([
    "allowed_providers",
    "allow_agent_root_propose",
    "allow_pass_to_agent",
    "allow_run_overrides",
  ]);
  const record = document as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new DomainError("invalid_config", "repository config contains an unsupported field");
  }
  const typed = record as RepositoryConfigDocument;
  if (
    (typed.allowed_providers !== undefined &&
      (!Array.isArray(typed.allowed_providers) ||
        typed.allowed_providers.some((provider) => typeof provider !== "string"))) ||
    [typed.allow_agent_root_propose, typed.allow_pass_to_agent, typed.allow_run_overrides].some(
      (value) => value !== undefined && typeof value !== "boolean",
    )
  ) {
    throw new DomainError("invalid_config", "repository config field type is invalid");
  }
  const normalized: RepositoryConfigDocument = {};
  if (typed.allowed_providers !== undefined) {
    normalized.allowed_providers = normalizeProviders(typed.allowed_providers);
  }
  if (typed.allow_agent_root_propose !== undefined) {
    normalized.allow_agent_root_propose = typed.allow_agent_root_propose;
  }
  if (typed.allow_pass_to_agent !== undefined) {
    normalized.allow_pass_to_agent = typed.allow_pass_to_agent;
  }
  if (typed.allow_run_overrides !== undefined) {
    normalized.allow_run_overrides = typed.allow_run_overrides;
  }
  const settings: PolicySettings = {
    allowedProviders: normalized.allowed_providers ?? parent.allowedProviders,
    allowAgentRootPropose: normalized.allow_agent_root_propose ?? parent.allowAgentRootPropose,
    allowPassToAgent: normalized.allow_pass_to_agent ?? parent.allowPassToAgent,
    allowRunOverrides: normalized.allow_run_overrides ?? parent.allowRunOverrides,
  };
  assertPolicyTightens(parent, settings);
  return { canonical: canonicalJson(normalized), settings };
}

export interface ReportRepositoryConfigInput {
  projectId: string;
  expectedVersion: number;
  document: unknown;
  contentHash: string;
}

export const reportRepositoryConfigCommand: HubCommand<
  ReportRepositoryConfigInput,
  { projectId: string; version: number; contentHash: string; canonicalJson: string }
> = {
  name: "repository.config.report",
  async run(input, ctx) {
    const principal = await requireOwner(ctx);
    await projectForPrincipal(ctx.db, principal, input.projectId);
    const workspace = policyFromRow(await workspacePolicy(ctx.db, ctx.workspaceId));
    const project = policyFromRow(await projectPolicy(ctx.db, ctx.workspaceId, input.projectId));
    assertPolicyTightens(workspace, project);
    const current = (await ctx.db
      .prepare(
        `SELECT resource_version FROM repository_configs
         WHERE workspace_id = ? AND project_id = ?`,
      )
      .get(ctx.workspaceId, input.projectId)) as { resource_version: number } | undefined;
    if (!current || current.resource_version !== input.expectedVersion) {
      throw new DomainError("stale_version", "repository config version conflict");
    }
    const normalized = normalizeRepositoryConfig(input.document, project);
    const hash = `sha256:${createHash("sha256").update(normalized.canonical, "utf8").digest("hex")}`;
    if (!HASH_PATTERN.test(input.contentHash) || input.contentHash !== hash) {
      throw new DomainError("config_hash_mismatch", "repository config hash does not match");
    }
    const next = current.resource_version + 1;
    const [providers, rootPropose, passToAgent, runOverrides] = policyValues(normalized.settings);
    await ctx.db
      .prepare(
        `UPDATE repository_configs
         SET canonical_json = ?, content_hash = ?, allowed_providers_json = ?,
             allow_agent_root_propose = ?, allow_pass_to_agent = ?,
             allow_run_overrides = ?, resource_version = ?
         WHERE workspace_id = ? AND project_id = ? AND resource_version = ?`,
      )
      .run(
        normalized.canonical,
        hash,
        providers,
        rootPropose,
        passToAgent,
        runOverrides,
        next,
        ctx.workspaceId,
        input.projectId,
        input.expectedVersion,
      );
    await ctx.db
      .prepare(
        `INSERT INTO repository_config_versions
         (workspace_id, project_id, version, canonical_json, content_hash,
          allowed_providers_json, allow_agent_root_propose, allow_pass_to_agent,
          allow_run_overrides, reported_by_human_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        input.projectId,
        next,
        normalized.canonical,
        hash,
        providers,
        rootPropose,
        passToAgent,
        runOverrides,
        principal.humanId,
        ctx.now,
      );
    return {
      projectId: input.projectId,
      version: next,
      contentHash: hash,
      canonicalJson: normalized.canonical,
    };
  },
};

export interface CreateAgentProfileInput {
  name: string;
  provider: Provider;
  model?: string;
  executionMode: "interactive" | "headless";
  harnessMode: "restricted" | "standard";
}

function normalizedProfile(
  input: CreateAgentProfileInput,
): Omit<AgentProfileRecord, "id" | "resource_version"> {
  if (!PROVIDERS.includes(input.provider)) {
    throw new DomainError("invalid_argument", "profile provider is invalid");
  }
  if (input.provider === "fake" && input.model !== "synthetic") {
    throw new DomainError("invalid_argument", "synthetic profiles require the synthetic model");
  }
  if (input.executionMode !== "interactive" && input.executionMode !== "headless") {
    throw new DomainError("invalid_argument", "profile execution mode is invalid");
  }
  if (input.harnessMode !== "restricted" && input.harnessMode !== "standard") {
    throw new DomainError("invalid_argument", "profile harness mode is invalid");
  }
  return {
    name: boundedText(input.name, "profile name", 128),
    provider: input.provider,
    model: input.model === undefined ? null : boundedText(input.model, "profile model", 128),
    execution_mode: input.executionMode,
    harness_mode: input.harnessMode,
  };
}

export const createAgentProfileCommand: HubCommand<CreateAgentProfileInput, AgentProfileRecord> = {
  name: "agent_profile.create",
  async run(input, ctx) {
    const principal = await requireOwner(ctx);
    const profile = normalizedProfile(input);
    const policy = policyFromRow(await workspacePolicy(ctx.db, ctx.workspaceId));
    if (!policy.allowedProviders.includes(profile.provider)) {
      throw new DomainError("provider_forbidden", "profile provider exceeds workspace policy");
    }
    const id = randomUlid();
    await ctx.db
      .prepare(
        `INSERT INTO agent_profiles
         (workspace_id, id, name, provider, model, execution_mode, harness_mode, resource_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        ctx.workspaceId,
        id,
        profile.name,
        profile.provider,
        profile.model,
        profile.execution_mode,
        profile.harness_mode,
      );
    await ctx.db
      .prepare(
        `INSERT INTO agent_profile_versions
         (workspace_id, profile_id, version, name, provider, model,
          execution_mode, harness_mode, created_by_human_id, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        id,
        profile.name,
        profile.provider,
        profile.model,
        profile.execution_mode,
        profile.harness_mode,
        principal.humanId,
        ctx.now,
      );
    return { id, ...profile, resource_version: 1 };
  },
};

export interface UpdateAgentProfileInput extends CreateAgentProfileInput {
  profileId: string;
  expectedVersion: number;
}

export const updateAgentProfileCommand: HubCommand<UpdateAgentProfileInput, AgentProfileRecord> = {
  name: "agent_profile.update",
  async run(input, ctx) {
    const principal = await requireOwner(ctx);
    const current = (await ctx.db
      .prepare(
        `SELECT id, name, provider, model, execution_mode, harness_mode, resource_version
         FROM agent_profiles WHERE workspace_id = ? AND id = ?`,
      )
      .get(ctx.workspaceId, input.profileId)) as AgentProfileRecord | undefined;
    if (!current) {
      throw new DomainError("not_found", "agent profile not found");
    }
    if (current.resource_version !== input.expectedVersion) {
      throw new DomainError("stale_version", "agent profile version conflict");
    }
    const profile = normalizedProfile(input);
    const policy = policyFromRow(await workspacePolicy(ctx.db, ctx.workspaceId));
    if (!policy.allowedProviders.includes(profile.provider)) {
      throw new DomainError("provider_forbidden", "profile provider exceeds workspace policy");
    }
    const next = current.resource_version + 1;
    await ctx.db
      .prepare(
        `UPDATE agent_profiles
         SET name = ?, provider = ?, model = ?, execution_mode = ?, harness_mode = ?,
             resource_version = ?
         WHERE workspace_id = ? AND id = ? AND resource_version = ?`,
      )
      .run(
        profile.name,
        profile.provider,
        profile.model,
        profile.execution_mode,
        profile.harness_mode,
        next,
        ctx.workspaceId,
        current.id,
        input.expectedVersion,
      );
    await ctx.db
      .prepare(
        `INSERT INTO agent_profile_versions
         (workspace_id, profile_id, version, name, provider, model,
          execution_mode, harness_mode, created_by_human_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        current.id,
        next,
        profile.name,
        profile.provider,
        profile.model,
        profile.execution_mode,
        profile.harness_mode,
        principal.humanId,
        ctx.now,
      );
    return { id: current.id, ...profile, resource_version: next };
  },
};

export async function getProject(
  db: SqlDatabase,
  workspaceId: string,
  projectId: string,
): Promise<ProjectRecord | undefined> {
  return (await db
    .prepare(
      `SELECT id, name, slug, tint, access_mode, repository_host,
              hosted_repository_id, repository_subpath, resource_version
       FROM projects WHERE workspace_id = ? AND id = ?`,
    )
    .get(workspaceId, projectId)) as ProjectRecord | undefined;
}

export async function listProjectsPage(
  db: SqlDatabase,
  principal: AuthzPrincipal,
  options: { limit?: number; cursor?: string } = {},
): Promise<{ projects: ProjectRecord[]; hasMore: boolean; nextCursor?: string }> {
  if (principal.projectIds.length === 0) {
    return { projects: [], hasMore: false };
  }
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const placeholders = principal.projectIds.map(() => "?").join(", ");
  const values: unknown[] = [principal.workspaceId, ...principal.projectIds];
  const cursor = options.cursor ? " AND id > ?" : "";
  if (options.cursor) {
    values.push(options.cursor);
  }
  values.push(limit + 1);
  const rows = (await db
    .prepare(
      `SELECT id, name, slug, tint, access_mode, repository_host,
              hosted_repository_id, repository_subpath, resource_version
       FROM projects
       WHERE workspace_id = ? AND id IN (${placeholders})${cursor}
       ORDER BY id ASC LIMIT ?`,
    )
    .all(...values)) as ProjectRecord[];
  const hasMore = rows.length > limit;
  const projects = hasMore ? rows.slice(0, limit) : rows;
  const result: { projects: ProjectRecord[]; hasMore: boolean; nextCursor?: string } = {
    projects,
    hasMore,
  };
  if (hasMore) {
    result.nextCursor = projects[projects.length - 1]!.id;
  }
  return result;
}

export async function listAgentProfilesPage(
  db: SqlDatabase,
  workspaceId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<{ profiles: AgentProfileRecord[]; hasMore: boolean; nextCursor?: string }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const cursor = options.cursor ? " AND id > ?" : "";
  const values: unknown[] = [workspaceId];
  if (options.cursor) {
    values.push(options.cursor);
  }
  values.push(limit + 1);
  const rows = (await db
    .prepare(
      `SELECT id, name, provider, model, execution_mode, harness_mode, resource_version
       FROM agent_profiles WHERE workspace_id = ?${cursor} ORDER BY id ASC LIMIT ?`,
    )
    .all(...values)) as AgentProfileRecord[];
  const hasMore = rows.length > limit;
  const profiles = hasMore ? rows.slice(0, limit) : rows;
  const result: { profiles: AgentProfileRecord[]; hasMore: boolean; nextCursor?: string } = {
    profiles,
    hasMore,
  };
  if (hasMore) {
    result.nextCursor = profiles[profiles.length - 1]!.id;
  }
  return result;
}

export async function listVersionRows(
  db: SqlDatabase,
  table:
    | "workspace_policy_versions"
    | "project_policy_versions"
    | "repository_config_versions"
    | "agent_profile_versions",
  workspaceId: string,
  boundary: { projectId?: string; profileId?: string } = {},
  options: { limit?: number; cursor?: number } = {},
): Promise<{ versions: unknown[]; hasMore: boolean; nextCursor?: number }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  let where = "workspace_id = ?";
  const values: unknown[] = [workspaceId];
  if (boundary.projectId) {
    where += " AND project_id = ?";
    values.push(boundary.projectId);
  }
  if (boundary.profileId) {
    where += " AND profile_id = ?";
    values.push(boundary.profileId);
  }
  if (options.cursor !== undefined) {
    where += " AND version > ?";
    values.push(options.cursor);
  }
  values.push(limit + 1);
  const rows = await db
    .prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY version ASC LIMIT ?`)
    .all(...values);
  const hasMore = rows.length > limit;
  const versions = hasMore ? rows.slice(0, limit) : rows;
  const result: { versions: unknown[]; hasMore: boolean; nextCursor?: number } = {
    versions,
    hasMore,
  };
  if (hasMore) {
    result.nextCursor = (versions[versions.length - 1] as { version: number }).version;
  }
  return result;
}

export async function getWorkspacePolicy(
  db: SqlDatabase,
  workspaceId: string,
): Promise<PolicySettings & { resourceVersion: number }> {
  const row = await workspacePolicy(db, workspaceId);
  return { ...policyFromRow(row), resourceVersion: row.resource_version };
}

export async function getProjectPolicy(
  db: SqlDatabase,
  workspaceId: string,
  projectId: string,
): Promise<PolicySettings & { resourceVersion: number }> {
  const row = await projectPolicy(db, workspaceId, projectId);
  return { ...policyFromRow(row), resourceVersion: row.resource_version };
}

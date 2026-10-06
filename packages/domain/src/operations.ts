// ABOUTME: Owner-gated operations read models, retention policy, diagnostics, and privileged recovery.
// ABOUTME: Security audit and activity stay distinct; retention never deletes hashes, metadata, or blobs.

import { createHash } from "node:crypto";

import type { SqlDatabase } from "@bfb/db";

import { assertEpoch, assertRole, loadPrincipal } from "./authorization.js";
import { ARTIFACT_ABANDON_GRACE_MS, ARTIFACT_GRANT_TTL_MS } from "./artifacts.js";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { isUlid, randomUlid } from "./ids.js";
import { validateStepUpProof, type StepUpAction } from "./step-up.js";
import {
  sharedTaskPredicate,
  taskAccessPredicate,
  type TaskAccessContext,
  type TaskAccessAction,
} from "./task-access.js";

/** D1 migration that owns the X05 operations tables. Asserted registered, never as newest head. */
export const OPS_MIGRATION_ID = "0034_operations";

/** Fresh action-bound step-up actions owned by X05. */
export const OPS_STEP_UP_ACTIONS = {
  recover: "ops.recover",
  retention: "ops.retention",
  diagnosticGenerate: "diagnostic.generate",
  diagnosticUpload: "diagnostic.upload",
} as const;

/** Raw-log retention window bounds (days) and the workspace default. */
export const RETENTION_MIN_DAYS = 1;
export const RETENTION_MAX_DAYS = 365;
export const RETENTION_DEFAULT_DAYS = 30;

/** Diagnostic bundles expire unconsented after 24h; uploads stay addressable by id. */
export const DIAGNOSTIC_BUNDLE_TTL_MS = 24 * 60 * 60_000;

/** A claimed launch without final authorization this old is stuck. */
export const STUCK_LAUNCH_CLAIM_MS = 10 * 60_000;

/** A runner inventory older than this is stale; providers populate it, X05 only reads it. */
export const PROVIDER_RECORD_STALE_MS = 5 * 60_000;

/** Runner tokens expiring within this window need rotation. */
export const TOKEN_ROTATION_WARN_MS = 24 * 60 * 60_000;

/** Recovery and read-model page bounds. */
export const OPS_MAX_TARGETS = 50;
export const OPS_MAX_PAGE = 100;

/** Operations task projections remain shared-only even for a private creator. */
function operationsTaskPredicate(access?: TaskAccessContext, action: TaskAccessAction = "read") {
  const shared = sharedTaskPredicate("ops_task");
  if (!access) return { sql: shared, parameters: [] };
  const current = taskAccessPredicate(access, action, "ops_task");
  return { sql: `(${shared} AND ${current.sql})`, parameters: current.parameters };
}

/** Run-free work and task-bound operator lists retain the owner/member ceiling. */
function operationsWorkspacePredicate(
  access: TaskAccessContext | undefined,
  alias: "v" | "launch" | "ops_scope",
  ownerOnly = false,
) {
  if (!access) return { sql: "1", parameters: [] };
  return {
    sql: `${alias}.workspace_id = ? AND EXISTS (
      SELECT 1 FROM workspace_members AS ops_member
      JOIN workspace_authorization_epochs AS ops_epoch
        ON ops_epoch.workspace_id = ops_member.workspace_id
          AND ops_epoch.human_id = ops_member.human_id
          AND ops_epoch.authorization_epoch = ops_member.authorization_epoch
          AND ops_epoch.revoked_at IS NULL
      WHERE ops_member.workspace_id = ${alias}.workspace_id AND ops_member.human_id = ?
        AND ops_epoch.authorization_epoch = ? AND ops_member.role IN (${ownerOnly ? "'owner'" : "'owner', 'member'"})
    )`,
    parameters: [access.workspaceId, access.humanId, access.authorizationEpoch],
  };
}

function fail(code: string, message: string): never {
  throw new DomainError(code, message);
}

function closedObject(value: unknown, allowed: string[], what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_argument", `${what} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      fail("invalid_argument", `${what} rejects field ${key}`);
    }
  }
  return record;
}

function ulidField(value: unknown, field: string): string {
  if (typeof value !== "string" || !isUlid(value)) {
    fail("invalid_argument", `${field} must be a ULID`);
  }
  return value;
}

function ulidList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > OPS_MAX_TARGETS) {
    fail("invalid_argument", `${field} must list 1 to ${OPS_MAX_TARGETS} ids`);
  }
  const seen = new Set<string>();
  for (const entry of value) {
    const id = ulidField(entry, field);
    if (seen.has(id)) {
      fail("invalid_argument", `${field} must not repeat ${id}`);
    }
    seen.add(id);
  }
  return [...seen];
}

async function requireOwner(ctx: HubContext) {
  if (ctx.actorDelegationId) {
    fail("forbidden", "direct authorized human required");
  }
  if (!ctx.actorHumanId) {
    fail("unauthenticated", "human actor required");
  }
  const principal = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
  assertEpoch(principal, ctx.authorizationEpoch);
  assertRole(principal, ["owner"]);
  return principal;
}

async function prepareStepUp(
  ctx: HubContext,
  proofId: string,
  action: string,
  targetId: string,
): Promise<() => Promise<void>> {
  if (typeof proofId !== "string" || !proofId) {
    fail("step_up_invalid", "step-up proof is required");
  }
  const proof = (await ctx.db
    .prepare(`SELECT expires_at FROM passkey_step_up_proofs WHERE proof_id = ?`)
    .get(proofId)) as { expires_at: string } | undefined;
  if (!proof || !ctx.actorHumanId) {
    fail("step_up_invalid", "step-up proof is invalid");
  }
  const expected: StepUpAction = {
    action,
    workspaceId: ctx.workspaceId,
    targetId,
    scopes: [],
    authorizationEpoch: ctx.authorizationEpoch,
    expiresAt: proof.expires_at,
  };
  await validateStepUpProof(ctx.db, proofId, expected, ctx.now, ctx.actorHumanId);
  const stamp = randomUlid();
  return async () => {
    await ctx.db
      .prepare(
        `UPDATE passkey_step_up_proofs SET consumed_at = ? WHERE proof_id = ? AND consumed_at IS NULL AND expires_at > ?`,
      )
      .run(stamp, proofId, ctx.now);
    // Write-only single-winner check: D1 batches forbid reads after a queued
    // write, so the predicate aborts the batch instead of returning a count.
    const guardId = randomUlid();
    await ctx.db
      .prepare(
        `INSERT INTO runner_mutation_guards (id, valid)
         VALUES (?, ((SELECT COUNT(*) FROM passkey_step_up_proofs WHERE proof_id = ? AND consumed_at = ?) = 1))`,
      )
      .run(guardId, proofId, stamp);
    await ctx.db.prepare(`DELETE FROM runner_mutation_guards WHERE id = ?`).run(guardId);
  };
}

export interface RetentionPolicy {
  workspace_id: string;
  raw_log_retention_days: number;
  version: number;
  updated_by_human_id: string;
  updated_at: string;
}

export function retentionCutoff(nowIso: string, days: number): string {
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) {
    fail("invalid_argument", "now must be a timestamp");
  }
  return new Date(now - days * 24 * 60 * 60_000).toISOString();
}

export async function getRetentionPolicy(
  db: SqlDatabase,
  workspaceId: string,
): Promise<RetentionPolicy | null> {
  return (
    ((await db
      .prepare(`SELECT * FROM retention_policies WHERE workspace_id = ?`)
      .get(workspaceId)) as RetentionPolicy | null | undefined) ?? null
  );
}

export interface SetRetentionPolicyInput {
  rawLogRetentionDays: number;
  stepUpProofId: string;
}

export const setRetentionPolicyCommand: HubCommand<SetRetentionPolicyInput, RetentionPolicy> = {
  name: "ops.retention.set",
  replay: "reject",
  auditInput: (input) => ({ raw_log_retention_days: input.rawLogRetentionDays }),
  async run(input, ctx) {
    closedObject(input, ["rawLogRetentionDays", "stepUpProofId"], "ops retention");
    const days = input.rawLogRetentionDays;
    if (!Number.isInteger(days) || days < RETENTION_MIN_DAYS || days > RETENTION_MAX_DAYS) {
      fail(
        "invalid_argument",
        `retention window must be ${RETENTION_MIN_DAYS} to ${RETENTION_MAX_DAYS} days`,
      );
    }
    const principal = await requireOwner(ctx);
    // All reads precede the step-up consume: D1 batches forbid reads after a queued write.
    const existing = await getRetentionPolicy(ctx.db, ctx.workspaceId);
    const consume = await prepareStepUp(
      ctx,
      input.stepUpProofId,
      OPS_STEP_UP_ACTIONS.retention,
      `ops-retention:${ctx.workspaceId}`,
    );
    await consume();
    const version = (existing?.version ?? 0) + 1;
    await ctx.db
      .prepare(
        `INSERT INTO retention_policies (workspace_id, raw_log_retention_days, version, updated_by_human_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET
           raw_log_retention_days = excluded.raw_log_retention_days,
           version = excluded.version,
           updated_by_human_id = excluded.updated_by_human_id,
           updated_at = excluded.updated_at`,
      )
      .run(ctx.workspaceId, days, version, principal.humanId, ctx.now);
    return {
      workspace_id: ctx.workspaceId,
      raw_log_retention_days: days,
      version,
      updated_by_human_id: principal.humanId,
      updated_at: ctx.now,
    };
  },
};

export interface RetentionCandidate {
  version_id: string;
  artifact_id: string;
  run_id: string | null;
  r2_key: string;
  declared_size: number;
  available_at: string;
}

/**
 * Lists raw log chunks eligible for R2-object deletion. Eligibility is
 * deliberately narrow: role `log`, state `available`, older than the policy
 * cutoff, and keyed under the per-run logs prefix. Review artifacts, shared
 * content-addressed bytes, D1 rows, hashes, and metadata are never eligible.
 * A purged chunk moves to `retained` (see `markVersionRetained`), so it
 * never appears here again and its bytes are never counted twice.
 */
export interface RetentionSelection {
  policy: RetentionPolicy | null;
  cutoff: string;
  days: number;
  examined: number;
  eligible: RetentionCandidate[];
}

export async function listRetentionEligibleChunks(
  db: SqlDatabase,
  workspaceId: string,
  nowIso: string,
  access: TaskAccessContext,
): Promise<RetentionSelection> {
  if (!access) fail("invalid_argument", "human retention access is required");
  return selectRetentionChunks(db, workspaceId, nowIso, access, false);
}

/** Configured policy is system authority, never inferred human Owner authority. */
export async function listSystemRetentionEligibleChunks(
  db: SqlDatabase,
  workspaceId: string,
  nowIso: string,
): Promise<RetentionSelection> {
  return selectRetentionChunks(db, workspaceId, nowIso, undefined, true);
}

async function selectRetentionChunks(
  db: SqlDatabase,
  workspaceId: string,
  nowIso: string,
  access: TaskAccessContext | undefined,
  configuredSystem: boolean,
): Promise<RetentionSelection> {
  const policy = await getRetentionPolicy(db, workspaceId);
  const days = policy?.raw_log_retention_days ?? RETENTION_DEFAULT_DAYS;
  const cutoff = retentionCutoff(nowIso, days);
  if (configuredSystem && !policy) return { policy, cutoff, days, examined: 0, eligible: [] };
  const parent = configuredSystem ? { sql: "1", parameters: [] } : operationsTaskPredicate(access);
  const human = configuredSystem
    ? { sql: "1", parameters: [] }
    : operationsWorkspacePredicate(access, "v");
  const current = (await db
    .prepare(
      `SELECT * FROM (WITH current_scope AS MATERIALIZED (
       SELECT v.workspace_id, ${human.sql} AS authorized FROM (SELECT ? AS workspace_id) AS v
       ), current_candidates AS MATERIALIZED (
       SELECT v.id AS version_id, v.artifact_id, a.run_id, v.r2_key, v.declared_size, v.available_at
       FROM artifact_versions AS v
       JOIN current_scope AS scope ON scope.workspace_id = v.workspace_id AND scope.authorized
       JOIN artifacts AS a ON a.workspace_id = v.workspace_id AND a.id = v.artifact_id
       JOIN runs AS ops_run ON ops_run.workspace_id = a.workspace_id AND ops_run.id = a.run_id
       JOIN tasks AS ops_task ON ops_task.workspace_id = ops_run.workspace_id AND ops_task.id = ops_run.task_id
         AND ops_task.project_id = ops_run.project_id
       WHERE v.workspace_id = ?
         AND a.role = 'log'
         AND v.state = 'available'
         AND v.r2_key = 'workspaces/' || v.workspace_id || '/runs/' || ops_run.id || '/logs/' || v.id || '.jsonl.zst'
         AND ${parent.sql}
         ${configuredSystem ? "AND EXISTS (SELECT 1 FROM retention_policies AS policy WHERE policy.workspace_id = v.workspace_id AND policy.version = ? AND policy.raw_log_retention_days = ?)" : ""}
       ) SELECT scope.authorized, (SELECT json_group_array(json_object(
         'version_id',version_id,'artifact_id',artifact_id,'run_id',run_id,'r2_key',r2_key,
         'declared_size',declared_size,'available_at',available_at)) FROM current_candidates) AS candidates_json
       FROM current_scope AS scope)`,
    )
    .get(
      ...human.parameters,
      workspaceId,
      workspaceId,
      ...parent.parameters,
      ...(configuredSystem ? [policy!.version, days] : []),
    )) as { authorized: number; candidates_json: string };
  if (!current.authorized) fail("not_found", "operations scope not found");
  const rows = JSON.parse(current.candidates_json) as Array<{
    version_id: string;
    artifact_id: string;
    run_id: string | null;
    r2_key: string;
    declared_size: number;
    available_at: string | null;
  }>;
  const eligible = rows.filter(
    (row) => row.available_at !== null && (row.available_at as string) <= cutoff,
  );
  return {
    policy,
    cutoff,
    days,
    examined: rows.length,
    eligible: eligible.map((row) => ({
      version_id: row.version_id,
      artifact_id: row.artifact_id,
      run_id: row.run_id,
      r2_key: row.r2_key,
      declared_size: row.declared_size,
      available_at: row.available_at as string,
    })),
  };
}

/**
 * Records a retention purge on the version row. The guarded update moves an
 * `available` version to `retained` with every other column unchanged, so a
 * purged chunk is never re-listed as eligible and its view grants stop
 * redeeming (issuance and redemption both require `available`), while the
 * hash, key, and metadata stay intact as the purge record. Returns true when
 * this call performed the transition; a concurrent sweep that already
 * retained the row reports false so its bytes are never counted twice.
 */
export async function markVersionRetained(
  db: SqlDatabase,
  input: { workspaceId: string; versionId: string },
): Promise<boolean> {
  const updated = (await db
    .prepare(
      `UPDATE artifact_versions
       SET state = 'retained'
       WHERE workspace_id = ? AND id = ? AND state = 'available'`,
    )
    .run(input.workspaceId, input.versionId)) as { changes?: number } | undefined;
  return (updated?.changes ?? 0) === 1;
}

/**
 * Secrets and private payloads that must never appear in logs, bundles, or
 * evidence. The scanner reports hits; generation paths only emit allowlisted
 * fields so a hit is a defect, never an expected case.
 */
const PROHIBITED_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "cookie", pattern: /cookie/i },
  { name: "bearer_secret", pattern: /bearer\s+[A-Za-z0-9\-._~+/=]+/i },
  { name: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "github_token", pattern: /gh[pousr]_[A-Za-z0-9]+/ },
  { name: "vapid_private", pattern: /VAPID_PRIVATE_KEY/i },
  { name: "webhook_secret", pattern: /GITHUB_WEBHOOK_SECRET/i },
  { name: "local_path", pattern: /(\/Users\/|\/home\/|\/var\/folders\/|[A-Za-z]:\\)/ },
  { name: "launch_command", pattern: /bfb\s+__launch/ },
];

const SENSITIVE_KEY_PATTERN =
  /(secret|token|bearer|cookie|password|credential|private_key|grant_secret|view_secret|prompt|task_body|hook_payload|terminal|artifact_bytes|path|cwd|executable|argv)/i;

/**
 * Free-text content keys never survive into audit/diagnostic display, even
 * when an older audit row stored a full command input. Identifiers
 * (*_hash, *_id, *_at, *_cursor, *_count, *_version, *_epoch) are kept.
 */
const CONTENT_KEY_PATTERN =
  /(title|body|text|question|answer|comment|description|summary|punchline|prompt|instruction|brief|transcript|output|payload|message|label)/i;

const CONTENT_KEY_KEEP_SUFFIX = /(_hash|_id|_ids|_at|_cursor|_count|_version|_epoch)$/i;

/** Reports prohibited content in a rendered string. Empty means clean. */
export function scanDiagnosticText(rendered: string, canaries: string[] = []): string[] {
  const hits: string[] = [];
  for (const { name, pattern } of PROHIBITED_PATTERNS) {
    if (pattern.test(rendered)) {
      hits.push(name);
    }
  }
  for (const canary of canaries) {
    if (canary && rendered.includes(canary)) {
      hits.push(`canary:${canary.slice(0, 24)}`);
    }
  }
  return [...new Set(hits)];
}

/**
 * Sanitizes unknown JSON for audit/diagnostic display. Objects keep only
 * safe scalar fields; nested objects/arrays are summarized by shape, and any
 * key that smells like a secret, path, or private payload is dropped.
 */
export function sanitizeDiagnosticValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    if (
      value.length > 256 ||
      SENSITIVE_KEY_PATTERN.test(value) ||
      PROHIBITED_PATTERNS.some(({ pattern }) => pattern.test(value))
    ) {
      return "[redacted]";
    }
    return value;
  }
  if (depth >= 2 || typeof value !== "object") {
    return "[redacted]";
  }
  if (Array.isArray(value)) {
    if (value.length > 25) {
      return `[array:${value.length}]`;
    }
    return value.map((entry) => sanitizeDiagnosticValue(entry, depth + 1));
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > 25) {
    return `[object:${keys.length}]`;
  }
  const clean: Record<string, unknown> = {};
  for (const key of keys) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      continue;
    }
    if (CONTENT_KEY_PATTERN.test(key) && !CONTENT_KEY_KEEP_SUFFIX.test(key)) {
      continue;
    }
    clean[key] = sanitizeDiagnosticValue(record[key], depth + 1);
  }
  return clean;
}

export interface DiagnosticSection {
  name: string;
  fields: Record<string, string | number | boolean>;
}

export interface DiagnosticInventory {
  schema_version: 1;
  workspace_id: string;
  generated_at: string;
  generated_by: string;
  sections: DiagnosticSection[];
}

/** Builds the explicit bundle inventory from counts and cursors only. */
export async function buildDiagnosticInventory(
  db: SqlDatabase,
  workspaceId: string,
  humanId: string,
  nowIso: string,
): Promise<DiagnosticInventory> {
  async function count(table: string, extra = "", ...params: unknown[]): Promise<number> {
    const row = (await db
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ? ${extra}`)
      .get(workspaceId, ...params)) as { count: number };
    return row.count;
  }
  const queue = await readQueueState(db, workspaceId, nowIso);
  const stuckUploads = await listStuckUploads(db, workspaceId, nowIso);
  const stuckLaunches = await listStuckLaunches(db, workspaceId, nowIso);
  const sections: DiagnosticSection[] = [
    {
      name: "identity",
      fields: {
        workspace_id: workspaceId,
        members: await count("workspace_members"),
        runners: await count("runners"),
        projects: await count("projects"),
      },
    },
    {
      name: "work",
      fields: {
        tasks: await count("tasks"),
        runs: await count("runs"),
        attention_open: await count("attention_requests", "AND state = 'open'"),
        events: await count("semantic_events"),
        ledger_events: await count("event_ledger"),
      },
    },
    {
      name: "delivery",
      fields: {
        notification_pending: queue.notifications.pending,
        notification_dead_lettered: queue.notifications.dead_lettered,
        github_outbox_pending: queue.github_outbox.pending,
        github_dlq: queue.github_outbox.dlq,
        ops_recovery_applied: queue.ops_recovery.applied,
        ops_recovery_failed: queue.ops_recovery.failed,
      },
    },
    {
      name: "execution",
      fields: {
        stuck_uploads: stuckUploads.length,
        stuck_launches: stuckLaunches.length,
        artifact_versions: await count("artifact_versions"),
        launch_commands: await count("launch_commands"),
      },
    },
    {
      name: "integrations",
      fields: {
        github_installations: await count("github_app_installations"),
        github_evidence: await count("github_evidence"),
        runner_inventories: await count("runner_inventories"),
      },
    },
  ];
  return {
    schema_version: 1,
    workspace_id: workspaceId,
    generated_at: nowIso,
    generated_by: humanId,
    sections,
  };
}

export function renderDiagnosticInventory(inventory: DiagnosticInventory): string {
  return JSON.stringify(inventory);
}

export interface DiagnosticBundleRecord {
  workspace_id: string;
  id: string;
  created_by_human_id: string;
  state: string;
  inventory_json: string;
  bundle_hash: string;
  redaction_status: string;
  r2_key: string | null;
  created_at: string;
  consented_at: string | null;
  uploaded_at: string | null;
  expires_at: string;
  last_error: string | null;
}

function bundleHash(inventoryJson: string): string {
  return createHash("sha256").update(inventoryJson).digest("hex");
}

export const createDiagnosticBundleCommand: HubCommand<
  { stepUpProofId: string },
  DiagnosticBundleRecord
> = {
  name: "diagnostic.generate",
  replay: "reject",
  auditInput: () => ({ action: "diagnostic.generate" }),
  async run(input, ctx) {
    closedObject(input, ["stepUpProofId"], "diagnostic generate");
    const principal = await requireOwner(ctx);
    const bundleId = randomUlid();
    const consume = await prepareStepUp(
      ctx,
      input.stepUpProofId,
      OPS_STEP_UP_ACTIONS.diagnosticGenerate,
      `diagnostic:generate:${ctx.workspaceId}`,
    );
    const inventory = await buildDiagnosticInventory(
      ctx.db,
      ctx.workspaceId,
      principal.humanId,
      ctx.now,
    );
    const inventoryJson = renderDiagnosticInventory(inventory);
    const hits = scanDiagnosticText(inventoryJson);
    if (hits.length > 0) {
      fail("redaction_failed", `diagnostic inventory failed the secret scan: ${hits.join(",")}`);
    }
    await consume();
    const expiresAt = new Date(Date.parse(ctx.now) + DIAGNOSTIC_BUNDLE_TTL_MS).toISOString();
    const hash = bundleHash(inventoryJson);
    await ctx.db
      .prepare(
        `INSERT INTO diagnostic_bundles
         (workspace_id, id, created_by_human_id, state, inventory_json, bundle_hash,
          redaction_status, r2_key, created_at, consented_at, uploaded_at, expires_at, last_error)
         VALUES (?, ?, ?, 'pending_consent', ?, ?, 'passed', NULL, ?, NULL, NULL, ?, NULL)`,
      )
      .run(ctx.workspaceId, bundleId, principal.humanId, inventoryJson, hash, ctx.now, expiresAt);
    return {
      workspace_id: ctx.workspaceId,
      id: bundleId,
      created_by_human_id: principal.humanId,
      state: "pending_consent",
      inventory_json: inventoryJson,
      bundle_hash: hash,
      redaction_status: "passed",
      r2_key: null,
      created_at: ctx.now,
      consented_at: null,
      uploaded_at: null,
      expires_at: expiresAt,
      last_error: null,
    };
  },
};

export const consentDiagnosticUploadCommand: HubCommand<
  { bundleId: string; stepUpProofId: string },
  DiagnosticBundleRecord
> = {
  name: "diagnostic.upload_consent",
  replay: "reject",
  auditInput: (input) => ({ bundle_id: input.bundleId }),
  async run(input, ctx) {
    closedObject(input, ["bundleId", "stepUpProofId"], "diagnostic consent");
    const bundleId = ulidField(input.bundleId, "bundleId");
    await requireOwner(ctx);
    const row = (await ctx.db
      .prepare(`SELECT * FROM diagnostic_bundles WHERE workspace_id = ? AND id = ?`)
      .get(ctx.workspaceId, bundleId)) as DiagnosticBundleRecord | undefined;
    if (!row) {
      fail("not_found", "diagnostic bundle not found");
    }
    const bundle = row as DiagnosticBundleRecord;
    if (bundle.state !== "pending_consent" && bundle.state !== "consented") {
      fail("invalid_argument", `bundle in state ${bundle.state} cannot be consented`);
    }
    if (
      bundle.state === "pending_consent" &&
      Date.parse(bundle.expires_at) <= Date.parse(ctx.now)
    ) {
      fail("invalid_argument", "bundle consent expired");
    }
    const consume = await prepareStepUp(
      ctx,
      input.stepUpProofId,
      OPS_STEP_UP_ACTIONS.diagnosticUpload,
      `diagnostic:${bundleId}`,
    );
    await consume();
    if (bundle.state === "pending_consent") {
      await ctx.db
        .prepare(
          `UPDATE diagnostic_bundles SET state = 'consented', consented_at = ?
           WHERE workspace_id = ? AND id = ? AND state = 'pending_consent'`,
        )
        .run(ctx.now, ctx.workspaceId, bundleId);
      return { ...bundle, state: "consented", consented_at: ctx.now };
    }
    return bundle;
  },
};

export interface SecurityAuditEntry {
  audit_id: string;
  actor_principal_id: string;
  action: string;
  payload: unknown;
  created_at: string;
}

/**
 * Owner-only security audit read model. Payloads pass through the sanitizer
 * so older rows written before strict auditInput projection cannot leak
 * secrets, paths, or private payloads into the Operations surface.
 *
 * Rows are ordered chronologically by `created_at`, with insertion order
 * (`rowid`) breaking ties: audit ids carry no time component (hub ids are
 * random, recovery rows use an `audit-` prefix), so id order is not time
 * order. `after` stays an `audit_id` cursor but resolves to its row's
 * timestamp first, so pages advance in time, not id space.
 */
export async function readSecurityAudit(
  db: SqlDatabase,
  workspaceId: string,
  options: { limit?: number; after?: string } = {},
): Promise<{ entries: SecurityAuditEntry[]; has_more: boolean }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), OPS_MAX_PAGE);
  const params: unknown[] = [workspaceId];
  let cursorFilter = "";
  if (options.after) {
    const anchor = (await db
      .prepare(
        `SELECT created_at, rowid AS anchor_rowid FROM audit_events
         WHERE workspace_id = ? AND audit_id = ?`,
      )
      .get(workspaceId, options.after)) as { created_at: string; anchor_rowid: number } | undefined;
    if (!anchor) {
      fail("invalid_argument", "unknown audit cursor");
    }
    cursorFilter = "AND (created_at > ? OR (created_at = ? AND rowid > ?))";
    params.push(anchor.created_at, anchor.created_at, anchor.anchor_rowid);
  }
  const rows = (await db
    .prepare(
      `SELECT audit_id, actor_principal_id, action, payload_json, created_at
       FROM audit_events
       WHERE workspace_id = ? ${cursorFilter}
       ORDER BY created_at ASC, rowid ASC
       LIMIT ?`,
    )
    .all(...params, limit + 1)) as Array<{
    audit_id: string;
    actor_principal_id: string;
    action: string;
    payload_json: string;
    created_at: string;
  }>;
  const entries = rows.slice(0, limit).map((row) => {
    let payload: unknown = null;
    try {
      payload = JSON.parse(row.payload_json) as unknown;
    } catch {
      payload = "[unparseable]";
    }
    return {
      audit_id: row.audit_id,
      actor_principal_id: row.actor_principal_id,
      action: row.action,
      payload: sanitizeDiagnosticValue(payload),
      created_at: row.created_at,
    };
  });
  return { entries, has_more: rows.length > limit };
}

export interface ActivityEntry {
  workspace_cursor: number;
  kind: string;
  actor_type: string;
  actor_id: string;
  source_id: string;
  source_provider: string | null;
  project_id: string;
  task_id: string;
  run_id: string;
  occurred_at: string;
  received_at: string;
}

/**
 * Ordinary activity read model over the event ledger. Ledger payloads are
 * excluded by construction (they may carry provider observations); only the
 * typed envelope with actor/source attribution is exposed.
 */
export async function readActivityFeed(
  db: SqlDatabase,
  workspaceId: string,
  options: {
    limit?: number;
    afterCursor?: number;
    projectIds?: string[];
    access?: TaskAccessContext;
  } = {},
): Promise<{ entries: ActivityEntry[]; has_more: boolean }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), OPS_MAX_PAGE);
  const parent = operationsTaskPredicate(options.access);
  const params: unknown[] = [workspaceId];
  let extra = "";
  if (options.afterCursor !== undefined) {
    extra += " AND event.workspace_cursor > ?";
    params.push(options.afterCursor);
  }
  if (options.projectIds !== undefined) {
    if (options.projectIds.length === 0) {
      return { entries: [], has_more: false };
    }
    extra += ` AND event.project_id IN (${options.projectIds.map(() => "?").join(",")})`;
    params.push(...options.projectIds);
  }
  const rows = (await db
    .prepare(
      `SELECT event.workspace_cursor, event.kind, event.actor_type, event.actor_id,
              event.source_id, event.source_provider, event.project_id, event.task_id,
              event.run_id, event.occurred_at, event.received_at
       FROM event_ledger AS event
       WHERE event.workspace_id = ? ${extra} AND EXISTS (
         SELECT 1 FROM runs AS ops_run JOIN tasks AS ops_task
           ON ops_task.workspace_id = ops_run.workspace_id AND ops_task.id = ops_run.task_id
             AND ops_task.project_id = ops_run.project_id
         WHERE ops_run.workspace_id = event.workspace_id AND ops_run.id = event.run_id
           AND ops_run.task_id = event.task_id AND ops_run.project_id = event.project_id
           AND ${parent.sql}
       )
       ORDER BY event.workspace_cursor ASC
       LIMIT ?`,
    )
    .all(...params, ...parent.parameters, limit + 1)) as ActivityEntry[];
  return { entries: rows.slice(0, limit), has_more: rows.length > limit };
}

export interface StuckUpload {
  version_id: string;
  artifact_id: string;
  created_at: string;
  age_ms: number;
}

function uploadRecoveryCutoffs(nowIso: string) {
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) fail("invalid_argument", "now must be a timestamp");
  return {
    created: new Date(now - ARTIFACT_GRANT_TTL_MS - ARTIFACT_ABANDON_GRACE_MS).toISOString(),
    expiry: new Date(now - ARTIFACT_ABANDON_GRACE_MS).toISOString(),
  };
}

/** Uploading versions with no live grant past the grant TTL plus grace. */
export async function listStuckUploads(
  db: SqlDatabase,
  workspaceId: string,
  nowIso: string,
  access?: TaskAccessContext,
): Promise<StuckUpload[]> {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    return [];
  }
  const parent = operationsTaskPredicate(access);
  const human = operationsWorkspacePredicate(access, "v");
  const cutoffs = uploadRecoveryCutoffs(nowIso);
  const rows = (await db
    .prepare(
      `SELECT v.id AS version_id, v.artifact_id, v.created_at
       FROM artifact_versions AS v
       JOIN artifacts AS artifact ON artifact.workspace_id = v.workspace_id AND artifact.id = v.artifact_id
       WHERE v.workspace_id = ?
         AND v.state = 'uploading'
         AND v.created_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM artifact_upload_grants AS g
           WHERE g.workspace_id = v.workspace_id
             AND g.version_id = v.id
             AND g.expires_at > ?
         )
         AND (artifact.run_id IS NULL OR EXISTS (
           SELECT 1 FROM runs AS ops_run JOIN tasks AS ops_task
             ON ops_task.workspace_id = ops_run.workspace_id AND ops_task.id = ops_run.task_id
               AND ops_task.project_id = ops_run.project_id
           WHERE ops_run.workspace_id = artifact.workspace_id AND ops_run.id = artifact.run_id
             AND ${parent.sql}
         )) AND ${human.sql}
       ORDER BY v.created_at ASC`,
    )
    .all(
      workspaceId,
      cutoffs.created,
      cutoffs.expiry,
      ...parent.parameters,
      ...human.parameters,
    )) as Array<{
    version_id: string;
    artifact_id: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    version_id: row.version_id,
    artifact_id: row.artifact_id,
    created_at: row.created_at,
    age_ms: Math.max(0, nowMs - Date.parse(row.created_at)),
  }));
}

export interface StuckLaunch {
  command_id: string;
  run_id: string;
  state: string;
  expires_at: string;
  age_ms: number;
}

/**
 * Launch commands needing operator attention: expired while still pending,
 * or claimed long ago without final authorization. Recovery never mutates a
 * live claim; it only expires dead pending rows or surfaces guidance.
 */
export async function listStuckLaunches(
  db: SqlDatabase,
  workspaceId: string,
  nowIso: string,
  access?: TaskAccessContext,
): Promise<StuckLaunch[]> {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    return [];
  }
  const parent = operationsTaskPredicate(access);
  const human = operationsWorkspacePredicate(access, "launch");
  const rows = (await db
    .prepare(
      `SELECT launch.id AS command_id, launch.run_id, launch.state, launch.expires_at,
              COALESCE(launch.claimed_at, launch.created_at) AS since
       FROM launch_commands AS launch
       WHERE launch.workspace_id = ?
         AND ((launch.state = 'pending' AND datetime(launch.expires_at) <= datetime(?))
           OR (launch.state = 'claimed' AND launch.final_authorized_at IS NULL
               AND datetime(COALESCE(launch.claimed_at, launch.created_at)) <= datetime(?, '-600 seconds')))
         AND EXISTS (
           SELECT 1 FROM runs AS ops_run JOIN tasks AS ops_task
             ON ops_task.workspace_id = ops_run.workspace_id AND ops_task.id = ops_run.task_id
               AND ops_task.project_id = ops_run.project_id
           WHERE ops_run.workspace_id = launch.workspace_id AND ops_run.id = launch.run_id
             AND ${parent.sql}
         ) AND ${human.sql}
       ORDER BY since ASC`,
    )
    .all(workspaceId, nowIso, nowIso, ...parent.parameters, ...human.parameters)) as Array<{
    command_id: string;
    run_id: string;
    state: string;
    expires_at: string;
    since: string;
  }>;
  return rows.map((row) => ({
    command_id: row.command_id,
    run_id: row.run_id,
    state: row.state,
    expires_at: row.expires_at,
    age_ms: Math.max(0, nowMs - Date.parse(row.since)),
  }));
}

export interface QueueState {
  notifications: { pending: number; dead_lettered: number; failed: number };
  github_outbox: { pending: number; dispatched_stale: number; dlq: number };
  ops_recovery: { applied: number; failed: number };
}

export interface OperationsStuckWork {
  uploads: StuckUpload[];
  launches: StuckLaunch[];
  retention?: RetentionCandidate[];
}

/** Rechecks all hydrated references and the workspace scope in one final selection. */
export async function filterOperationsStuckWork(
  db: SqlDatabase,
  workspaceId: string,
  nowIso: string,
  work: OperationsStuckWork,
  access?: TaskAccessContext,
): Promise<OperationsStuckWork> {
  const parent = operationsTaskPredicate(access);
  const human = operationsWorkspacePredicate(access, "ops_scope");
  const cutoffs = uploadRecoveryCutoffs(nowIso);
  const refs = [
    ...work.uploads.map((row) => ({
      kind: "upload",
      id: row.version_id,
      parent_id: row.artifact_id,
    })),
    ...work.launches.map((row) => ({ kind: "launch", id: row.command_id, parent_id: row.run_id })),
    ...(work.retention ?? []).map((row) => ({
      kind: "retention",
      id: row.version_id,
      parent_id: row.artifact_id,
      run_id: row.run_id,
      r2_key: row.r2_key,
    })),
  ];
  const current = (await db
    .prepare(
      `SELECT * FROM (WITH current_scope AS MATERIALIZED (
       SELECT ops_scope.workspace_id, ${human.sql} AS authorized FROM (SELECT ? AS workspace_id) AS ops_scope
     ), requested AS MATERIALIZED (
       SELECT json_extract(ref.value,'$.kind') AS kind,json_extract(ref.value,'$.id') AS id,
         json_extract(ref.value,'$.parent_id') AS parent_id,json_extract(ref.value,'$.run_id') AS run_id,
         json_extract(ref.value,'$.r2_key') AS r2_key FROM json_each(?) AS ref
     ), resolved AS MATERIALIZED (
       SELECT ref.*, version.state AS version_state,version.created_at,version.available_at,version.r2_key AS version_key,
         artifact.id AS artifact_id,artifact.run_id AS artifact_run_id,artifact.role AS artifact_role,
         launch.id AS launch_id,launch.state AS launch_state,launch.expires_at,launch.final_authorized_at,
         COALESCE(launch.claimed_at,launch.created_at) AS launch_since,ops_task.id AS task_id,
         scope.workspace_id
       FROM requested AS ref JOIN current_scope AS scope ON scope.authorized
     LEFT JOIN artifact_versions AS version ON version.workspace_id = scope.workspace_id
       AND ref.kind IN ('upload','retention') AND version.id = ref.id
     LEFT JOIN artifacts AS artifact ON artifact.workspace_id = version.workspace_id
       AND artifact.id = version.artifact_id AND artifact.id = ref.parent_id
     LEFT JOIN launch_commands AS launch ON launch.workspace_id = scope.workspace_id
       AND ref.kind = 'launch' AND launch.id = ref.id AND launch.run_id = ref.parent_id
     LEFT JOIN runs AS ops_run ON ops_run.workspace_id = scope.workspace_id
       AND ops_run.id = CASE WHEN ref.kind = 'launch' THEN launch.run_id ELSE artifact.run_id END
     LEFT JOIN tasks AS ops_task ON ops_task.workspace_id = ops_run.workspace_id
       AND ops_task.id = ops_run.task_id AND ops_task.project_id = ops_run.project_id
     ), current_tasks AS MATERIALIZED (
       SELECT ops_task.workspace_id,ops_task.id FROM tasks AS ops_task
       JOIN (SELECT DISTINCT workspace_id,task_id FROM resolved) AS candidate
         ON candidate.workspace_id = ops_task.workspace_id AND candidate.task_id = ops_task.id
       WHERE ${parent.sql}
     ), permitted AS MATERIALIZED (
       SELECT ref.kind,ref.id FROM resolved AS ref
       LEFT JOIN current_tasks AS task ON task.workspace_id = ref.workspace_id AND task.id = ref.task_id
       WHERE ((ref.kind = 'upload' AND ref.artifact_id IS NOT NULL
         AND ref.version_state = 'uploading' AND ref.created_at <= ?
         AND NOT EXISTS (SELECT 1 FROM artifact_upload_grants AS upload_grant
           WHERE upload_grant.workspace_id = ref.workspace_id AND upload_grant.version_id = ref.id AND upload_grant.expires_at > ?))
       OR (ref.kind = 'launch' AND ref.launch_id IS NOT NULL
         AND ((ref.launch_state = 'pending' AND datetime(ref.expires_at) <= datetime(?))
           OR (ref.launch_state = 'claimed' AND ref.final_authorized_at IS NULL AND datetime(ref.launch_since) <= datetime(?, '-600 seconds'))))
       OR (ref.kind = 'retention' AND ${access ? "1" : "0"} AND ref.artifact_id IS NOT NULL AND ref.artifact_role = 'log'
         AND ref.version_state = 'available' AND ref.artifact_run_id = ref.run_id AND ref.version_key = ref.r2_key
         AND ref.version_key = 'workspaces/' || ref.workspace_id || '/runs/' || ref.run_id || '/logs/' || ref.id || '.jsonl.zst'
         AND ref.available_at <= strftime('%Y-%m-%dT%H:%M:%fZ',?, '-' || COALESCE((SELECT raw_log_retention_days FROM retention_policies WHERE workspace_id=ref.workspace_id),${RETENTION_DEFAULT_DAYS}) || ' days')))
       AND ((ref.kind = 'upload' AND ref.artifact_run_id IS NULL) OR task.id IS NOT NULL)
     ) SELECT scope.authorized,(SELECT json_group_array(json_object('kind',kind,'id',id)) FROM permitted) AS refs_json
     FROM current_scope AS scope)`,
    )
    .get(
      ...human.parameters,
      workspaceId,
      JSON.stringify(refs),
      ...parent.parameters,
      cutoffs.created,
      cutoffs.expiry,
      nowIso,
      nowIso,
      nowIso,
    )) as { authorized: number; refs_json: string };
  if (!current.authorized) fail("not_found", "operations scope not found");
  const rows = JSON.parse(current.refs_json) as Array<{ kind: string; id: string }>;
  const allowed = new Set(rows.map((row) => `${row.kind}:${row.id}`));
  return {
    uploads: work.uploads.filter((row) => allowed.has(`upload:${row.version_id}`)),
    launches: work.launches.filter((row) => allowed.has(`launch:${row.command_id}`)),
    ...(work.retention === undefined
      ? {}
      : { retention: work.retention.filter((row) => allowed.has(`retention:${row.version_id}`)) }),
  };
}

export async function readQueueState(
  db: SqlDatabase,
  workspaceId: string,
  nowIso: string,
): Promise<QueueState> {
  async function count(table: string, extra: string, ...params: unknown[]): Promise<number> {
    const row = (await db
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ? ${extra}`)
      .get(workspaceId, ...params)) as { count: number };
    return row.count;
  }
  return {
    notifications: {
      pending: await count("notification_deliveries", "AND state = 'pending'"),
      dead_lettered: await count("notification_deliveries", "AND state = 'dead_lettered'"),
      failed: await count("notification_deliveries", "AND state = 'failed'"),
    },
    github_outbox: {
      pending: await count("github_integration_outbox", "AND state = 'pending'"),
      dispatched_stale: await count(
        "github_integration_outbox",
        "AND state = 'dispatched' AND datetime(next_attempt_at) <= datetime(?)",
        nowIso,
      ),
      dlq: await count("github_dlq", ""),
    },
    ops_recovery: {
      applied: await count("ops_recovery_ledger", "AND state = 'applied'"),
      failed: await count("ops_recovery_ledger", "AND state = 'failed'"),
    },
  };
}

export interface ProviderRecordHealth {
  runner_id: string;
  present: boolean;
  received_age_ms: number | null;
  stale: boolean;
  providers: Array<{
    provider: string;
    status: string;
    version: string | null;
    observed_age_ms: number | null;
    expired: boolean;
  }>;
}

export interface WorkspaceHealth {
  schema_version: 1;
  workspace_id: string;
  checked_at: string;
  retention: { configured: boolean; days: number; version: number | null; eligible_chunks: number };
  queues: QueueState;
  launches: { stuck: StuckLaunch[] };
  uploads: { stuck: StuckUpload[] };
  tokens: { expiring_runner_tokens: number; active_api_bindings: number };
  providers: ProviderRecordHealth[];
}

/**
 * Workspace health assembled from committed rows only. Provider integration
 * records are read generically (presence, freshness, status enum): X05 never
 * interprets provider-specific capability fields; provider packages own them.
 */
export async function collectWorkspaceHealth(
  db: SqlDatabase,
  workspaceId: string,
  nowIso: string,
  access?: TaskAccessContext,
): Promise<WorkspaceHealth> {
  const nowMs = Date.parse(nowIso);
  const retentionList = access
    ? await listRetentionEligibleChunks(db, workspaceId, nowIso, access)
    : undefined;
  const policy =
    retentionList?.policy ?? (access ? null : await getRetentionPolicy(db, workspaceId));
  const queues = await readQueueState(db, workspaceId, nowIso);
  const stuckUploads = await listStuckUploads(db, workspaceId, nowIso, access);
  const stuckLaunches = await listStuckLaunches(db, workspaceId, nowIso, access);
  const expiring = (await db
    .prepare(
      `SELECT COUNT(*) AS count FROM runner_tokens
       WHERE workspace_id = ? AND revoked_at IS NULL
         AND datetime(expires_at) <= datetime(?, '+24 hours')`,
    )
    .get(workspaceId, nowIso)) as { count: number };
  const bindings = (await db
    .prepare(
      `SELECT COUNT(*) AS count FROM api_key_bindings WHERE workspace_id = ? AND revoked_at IS NULL`,
    )
    .get(workspaceId)) as { count: number };
  const runners = (await db
    .prepare(`SELECT id FROM runners WHERE workspace_id = ? AND revoked_at IS NULL`)
    .all(workspaceId)) as Array<{ id: string }>;
  const providers: ProviderRecordHealth[] = [];
  for (const runner of runners) {
    const row = (await db
      .prepare(
        `SELECT revision, inventory_json, received_at FROM runner_inventories
         WHERE workspace_id = ? AND runner_id = ?`,
      )
      .get(workspaceId, runner.id)) as
      { revision: number; inventory_json: string; received_at: string } | undefined;
    if (!row) {
      providers.push({
        runner_id: runner.id,
        present: false,
        received_age_ms: null,
        stale: true,
        providers: [],
      });
      continue;
    }
    let parsed: {
      providers?: Array<{
        provider: string;
        status: string;
        version?: string;
        observed_at: string;
        expires_at: string;
      }>;
    } = {};
    try {
      parsed = JSON.parse(row.inventory_json) as typeof parsed;
    } catch {
      parsed = {};
    }
    const receivedAge = Number.isFinite(nowMs)
      ? Math.max(0, nowMs - Date.parse(row.received_at))
      : null;
    providers.push({
      runner_id: runner.id,
      present: true,
      received_age_ms: receivedAge,
      stale: receivedAge === null || receivedAge > PROVIDER_RECORD_STALE_MS,
      providers: (parsed.providers ?? []).map((entry) => {
        const observedAge =
          Number.isFinite(nowMs) && entry.observed_at
            ? Math.max(0, nowMs - Date.parse(entry.observed_at))
            : null;
        return {
          provider: String(entry.provider),
          status: String(entry.status),
          version: typeof entry.version === "string" ? entry.version : null,
          observed_age_ms: observedAge,
          expired: !!entry.expires_at && Date.parse(entry.expires_at) <= nowMs,
        };
      }),
    });
  }
  const currentStuck = await filterOperationsStuckWork(
    db,
    workspaceId,
    nowIso,
    {
      uploads: stuckUploads,
      launches: stuckLaunches,
      retention: retentionList?.eligible ?? [],
    },
    access,
  );
  return {
    schema_version: 1,
    workspace_id: workspaceId,
    checked_at: nowIso,
    retention: {
      configured: policy !== null,
      days: policy?.raw_log_retention_days ?? RETENTION_DEFAULT_DAYS,
      version: policy?.version ?? null,
      eligible_chunks: currentStuck.retention?.length ?? 0,
    },
    queues,
    launches: { stuck: currentStuck.launches },
    uploads: { stuck: currentStuck.uploads },
    tokens: { expiring_runner_tokens: expiring.count, active_api_bindings: bindings.count },
    providers,
  };
}

/** Tables the operations surface reads; missing entries fail the migration check. */
export const OPS_REQUIRED_TABLES = [
  "audit_events",
  "semantic_events",
  "event_ledger",
  "launch_commands",
  "artifact_versions",
  "artifact_upload_grants",
  "artifacts",
  "notification_deliveries",
  "notification_dispatch_state",
  "github_integration_outbox",
  "github_dlq",
  "runner_tokens",
  "api_key_bindings",
  "runner_inventories",
  "runners",
  "retention_policies",
  "retention_runs",
  "diagnostic_bundles",
  "ops_recovery_ledger",
] as const;

export async function checkOperationsTables(
  db: SqlDatabase,
): Promise<{ ok: boolean; missing: string[] }> {
  const rows = (await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all()) as Array<{ name: string }>;
  const present = new Set(rows.map((row) => row.name));
  const missing = OPS_REQUIRED_TABLES.filter((table) => !present.has(table));
  return { ok: missing.length === 0, missing };
}

export const OPS_RECOVERY_KINDS = [
  "retry_notification_dispatch",
  "requeue_github_outbox",
  "resolve_stuck_upload",
  "clear_recovery_state",
] as const;

export type OpsRecoveryKind = (typeof OPS_RECOVERY_KINDS)[number];

export function recoveryActionId(kind: string, target: unknown): string {
  const canonical = JSON.stringify(target);
  return `ops:${kind}:${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

export interface OpsRecoveryResult {
  action_id: string;
  kind: OpsRecoveryKind;
  replayed: boolean;
  detail: Record<string, number | string>;
}

export interface ResolveStuckUploadInput {
  versionIds: string[];
  stepUpProofId: string;
}

function uploadRecoverySelection(
  workspaceId: string,
  ids: string[],
  access: TaskAccessContext,
  state: "uploading" | "failed",
  now: string,
) {
  const human = operationsWorkspacePredicate(access, "ops_scope", true);
  const parent = operationsTaskPredicate(access, "contribute");
  const cutoffs = uploadRecoveryCutoffs(now);
  return {
    sql: `SELECT * FROM (WITH current_owner AS MATERIALIZED (
      SELECT ops_scope.workspace_id FROM (SELECT ? AS workspace_id) AS ops_scope WHERE ${human.sql}
    ), requested AS MATERIALIZED (SELECT key AS ref_index,value AS id FROM json_each(?)),
    resolved AS MATERIALIZED (
      SELECT requested.ref_index,v.id,v.artifact_id,v.state,v.created_at,artifact.run_id,
        ops_task.id AS task_id,ops_run.project_id,owner.workspace_id
      FROM requested JOIN current_owner AS owner ON 1
      JOIN artifact_versions AS v ON v.workspace_id=owner.workspace_id AND v.id=requested.id
      JOIN artifacts AS artifact ON artifact.workspace_id=v.workspace_id AND artifact.id=v.artifact_id
      LEFT JOIN runs AS ops_run ON ops_run.workspace_id=artifact.workspace_id AND ops_run.id=artifact.run_id
      LEFT JOIN tasks AS ops_task ON ops_task.workspace_id=ops_run.workspace_id AND ops_task.id=ops_run.task_id
        AND ops_task.project_id=ops_run.project_id
    ), current_tasks AS MATERIALIZED (
      SELECT ops_task.workspace_id,ops_task.id FROM tasks AS ops_task
      JOIN (SELECT DISTINCT workspace_id,task_id FROM resolved) AS candidate
        ON candidate.workspace_id=ops_task.workspace_id AND candidate.task_id=ops_task.id
      WHERE ${parent.sql}
    ), selected AS MATERIALIZED (
      SELECT target.* FROM resolved AS target LEFT JOIN current_tasks AS task
        ON task.workspace_id=target.workspace_id AND task.id=target.task_id
      WHERE target.state=? AND (target.run_id IS NULL OR task.id IS NOT NULL)
        ${
          state === "uploading"
            ? `AND target.created_at <= ? AND NOT EXISTS (
          SELECT 1 FROM artifact_upload_grants AS upload_grant WHERE upload_grant.workspace_id=target.workspace_id
            AND upload_grant.version_id=target.id AND upload_grant.expires_at > ?)`
            : ""
        }
    ) SELECT (SELECT json_group_array(json_array(id,artifact_id,run_id,task_id,project_id,state,created_at))
      FROM (SELECT * FROM selected ORDER BY ref_index)) AS witness
    FROM current_owner WHERE (SELECT COUNT(*) FROM selected) = ?)`,
    parameters: [
      workspaceId,
      ...human.parameters,
      JSON.stringify(ids),
      ...parent.parameters,
      state,
      ...(state === "uploading" ? [cutoffs.created, cutoffs.expiry] : []),
      ids.length,
    ],
  };
}

/** Final browser delivery requires current Owner/shared-parent access to failed targets. */
export async function assertOperationsUploadRecoveryAccess(
  db: SqlDatabase,
  workspaceId: string,
  versionIds: string[],
  access: TaskAccessContext,
): Promise<void> {
  if (!access) fail("not_found", "upload recovery target not found");
  const ids = ulidList(versionIds, "versionIds");
  const selection = uploadRecoverySelection(
    workspaceId,
    ids,
    access,
    "failed",
    new Date().toISOString(),
  );
  if (!(await db.prepare(selection.sql).get(...selection.parameters)))
    fail("not_found", "upload recovery target not found");
}

const recoveryLedgerWitness = `json_array(kind,target_json,state,attempt_count,result_json,created_by_human_id,created_at,updated_at)`;
const recoveryProofWitness = `json_array(human_id,action,client_id,resource,boundary_json,scopes_json,authorization_epoch,expires_at,created_at,consumed_at)`;

async function prepareUploadRecovery(input: ResolveStuckUploadInput, ctx: HubContext) {
  closedObject(input, ["versionIds", "stepUpProofId"], "upload recovery");
  const ids = ulidList(input.versionIds, "versionIds");
  if (ctx.actorRunnerId || ctx.actorSystemId) fail("forbidden", "direct authorized human required");
  const principal = await requireOwner(ctx);
  const targetJson = JSON.stringify({ version_ids: ids });
  const actionId = recoveryActionId("resolve_stuck_upload", { version_ids: ids });
  const stored = (await ctx.db
    .prepare(
      `SELECT kind,target_json,state,result_json,${recoveryLedgerWitness} AS witness
    FROM ops_recovery_ledger WHERE workspace_id=? AND action_id=?`,
    )
    .get(ctx.workspaceId, actionId)) as
    | { kind: string; target_json: string; state: string; result_json: string; witness: string }
    | undefined;
  if (stored) {
    let result: unknown;
    try {
      result = JSON.parse(stored.result_json);
    } catch {
      fail("not_found", "upload recovery target not found");
    }
    if (
      stored.kind !== "resolve_stuck_upload" ||
      stored.target_json !== targetJson ||
      stored.state !== "applied" ||
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      Object.keys(result).length !== 1 ||
      !Object.hasOwn(result, "resolved") ||
      (result as { resolved: unknown }).resolved !== ids.length
    )
      fail("not_found", "upload recovery target not found");
  }
  const proof = (await ctx.db
    .prepare(
      `SELECT ${recoveryProofWitness} AS witness FROM passkey_step_up_proofs WHERE proof_id=?`,
    )
    .get(input.stepUpProofId)) as { witness: string } | undefined;
  const consume = await prepareStepUp(
    ctx,
    input.stepUpProofId,
    "ops.recover",
    `ops-recover:resolve_stuck_upload:${ctx.workspaceId}`,
  );
  const access: TaskAccessContext = {
    workspaceId: ctx.workspaceId,
    humanId: principal.humanId,
    authorizationEpoch: ctx.authorizationEpoch,
  };
  const selection = uploadRecoverySelection(
    ctx.workspaceId,
    ids,
    access,
    stored ? "failed" : "uploading",
    ctx.now,
  );
  const targets = (await ctx.db.prepare(selection.sql).get(...selection.parameters)) as
    { witness: string } | undefined;
  if (!targets) fail("not_found", "upload recovery target not found");
  return { ids, principal, actionId, targetJson, stored, consume, selection, targets, proof };
}

async function guardRecovery(ctx: HubContext, predicate: string, parameters: unknown[]) {
  const id = randomUlid();
  await ctx.db
    .prepare(
      `INSERT INTO artifact_mutation_guards (id,valid) SELECT ?,CASE WHEN (${predicate}) THEN 1 ELSE 0 END`,
    )
    .run(id, ...parameters);
  await ctx.db.prepare("DELETE FROM artifact_mutation_guards WHERE id=?").run(id);
}

/** Current authority, proof, targets, abandonment and receipts commit through the Hub lane. */
export const resolveStuckUploadCommand: HubCommand<ResolveStuckUploadInput, OpsRecoveryResult> = {
  name: "ops.recovery.resolve_stuck_upload",
  replay: "reject",
  auditInput: (input) => ({ version_ids: input.versionIds }),
  auditResult: (result) => ({
    action_id: result.action_id,
    kind: result.kind,
    replayed: result.replayed,
    resolved: result.detail.resolved,
  }),
  async authorize(input, ctx) {
    await prepareUploadRecovery(input, { ...ctx, now: new Date().toISOString() });
  },
  async run(input, ctx) {
    const prepared = await prepareUploadRecovery(input, ctx);
    // Every source is selected together; compare its exact association/state
    // witness again inside the same batch, before consuming proof or changing rows.
    await guardRecovery(ctx, `(SELECT witness FROM (${prepared.selection.sql})) = ?`, [
      ...prepared.selection.parameters,
      prepared.targets.witness,
    ]);
    await guardRecovery(
      ctx,
      prepared.stored
        ? `EXISTS (SELECT 1 FROM ops_recovery_ledger WHERE workspace_id=? AND action_id=? AND ${recoveryLedgerWitness}=?)`
        : `NOT EXISTS (SELECT 1 FROM ops_recovery_ledger WHERE workspace_id=? AND action_id=?)`,
      [ctx.workspaceId, prepared.actionId, ...(prepared.stored ? [prepared.stored.witness] : [])],
    );
    await guardRecovery(
      ctx,
      `EXISTS (SELECT 1 FROM passkey_step_up_proofs WHERE proof_id=? AND ${recoveryProofWitness}=?)`,
      [input.stepUpProofId, prepared.proof!.witness],
    );
    await prepared.consume();
    if (!prepared.stored) {
      for (const versionId of prepared.ids) {
        await ctx.db
          .prepare(
            "UPDATE artifact_versions SET state='failed' WHERE workspace_id=? AND id=? AND state='uploading'",
          )
          .run(ctx.workspaceId, versionId);
        await ctx.db
          .prepare(
            `INSERT INTO artifact_audit_outbox (workspace_id,id,version_id,grant_id,action,payload_json,created_at)
          VALUES (?,?,?,NULL,'artifact.abandoned',?,?)`,
          )
          .run(
            ctx.workspaceId,
            randomUlid(),
            versionId,
            JSON.stringify({ version_id: versionId }),
            ctx.now,
          );
      }
      await ctx.db
        .prepare(
          `INSERT INTO ops_recovery_ledger (workspace_id,action_id,kind,target_json,state,attempt_count,result_json,created_by_human_id,created_at,updated_at)
        VALUES (?,?,'resolve_stuck_upload',?,'applied',1,?,?,?,?)`,
        )
        .run(
          ctx.workspaceId,
          prepared.actionId,
          prepared.targetJson,
          JSON.stringify({ resolved: prepared.ids.length }),
          prepared.principal.humanId,
          ctx.now,
          ctx.now,
        );
    }
    return {
      action_id: prepared.actionId,
      kind: "resolve_stuck_upload",
      replayed: !!prepared.stored,
      detail: { resolved: prepared.ids.length },
    };
  },
};

/**
 * Applies one privileged recovery idempotently. Retries with an identical
 * target return the stored outcome without touching domain state again.
 * Notification redispatch rewinds the X01 watermark and GitHub requeue resets
 * rows the X04 reconciler already converges. Upload resolution is rejected
 * here and uses the explicit proof-bound WorkspaceHub command instead.
 */
export async function applyOpsRecovery(input: {
  db: SqlDatabase;
  workspaceId: string;
  kind: OpsRecoveryKind;
  target: Record<string, unknown>;
  actorHumanId: string;
  now: string;
}): Promise<OpsRecoveryResult> {
  const db = input.db;
  if (!OPS_RECOVERY_KINDS.includes(input.kind)) {
    fail("invalid_argument", `unknown recovery kind ${input.kind}`);
  }
  if (input.kind === "resolve_stuck_upload")
    fail("request_rejected", "upload recovery requires WorkspaceHub");
  const actionId = recoveryActionId(input.kind, input.target);
  const stored = (await db
    .prepare(
      `SELECT state, result_json, target_json FROM ops_recovery_ledger WHERE workspace_id = ? AND action_id = ?`,
    )
    .get(input.workspaceId, actionId)) as
    { state: string; result_json: string; target_json: string } | undefined;
  if (stored && stored.state === "applied" && stored.target_json === JSON.stringify(input.target)) {
    return {
      action_id: actionId,
      kind: input.kind,
      replayed: true,
      detail: JSON.parse(stored.result_json) as Record<string, number | string>,
    };
  }
  const detail = await runRecoveryEffect(
    db,
    input.workspaceId,
    input.kind,
    input.target,
    input.now,
  );
  await db
    .prepare(
      `INSERT INTO ops_recovery_ledger
       (workspace_id, action_id, kind, target_json, state, attempt_count,
        result_json, created_by_human_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'applied', COALESCE((SELECT attempt_count FROM ops_recovery_ledger WHERE workspace_id = ? AND action_id = ?), 0) + 1, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, action_id) DO UPDATE SET
         state = 'applied', attempt_count = ops_recovery_ledger.attempt_count + 1,
         result_json = excluded.result_json, updated_at = excluded.updated_at`,
    )
    .run(
      input.workspaceId,
      actionId,
      input.kind,
      JSON.stringify(input.target),
      input.workspaceId,
      actionId,
      JSON.stringify(detail),
      input.actorHumanId,
      input.now,
      input.now,
    );
  return { action_id: actionId, kind: input.kind, replayed: false, detail };
}

async function runRecoveryEffect(
  db: SqlDatabase,
  workspaceId: string,
  kind: OpsRecoveryKind,
  target: Record<string, unknown>,
  now: string,
): Promise<Record<string, number | string>> {
  switch (kind) {
    case "retry_notification_dispatch": {
      const body = closedObject(target, ["cursors"], "notification redispatch");
      if (
        !Array.isArray(body.cursors) ||
        body.cursors.length < 1 ||
        body.cursors.length > OPS_MAX_TARGETS
      ) {
        fail("invalid_argument", "cursors must list 1 to 50 event cursors");
      }
      const cursors = (body.cursors as unknown[]).map((cursor) => {
        if (!Number.isInteger(cursor) || (cursor as number) < 1) {
          fail("invalid_argument", "cursors must be positive integers");
        }
        return cursor as number;
      });
      for (const cursor of cursors) {
        const found = (await db
          .prepare(
            `SELECT workspace_cursor FROM semantic_events WHERE workspace_id = ? AND workspace_cursor = ?`,
          )
          .get(workspaceId, cursor)) as { workspace_cursor: number } | undefined;
        if (!found) {
          fail("invalid_argument", `event cursor ${cursor} does not exist`);
        }
      }
      const floor = Math.min(...cursors) - 1;
      await db
        .prepare(
          `INSERT INTO notification_dispatch_state (workspace_id, last_cursor, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT (workspace_id) DO UPDATE SET
             last_cursor = MIN(notification_dispatch_state.last_cursor, excluded.last_cursor),
             updated_at = excluded.updated_at`,
        )
        .run(workspaceId, floor, now);
      return { redispatched_from: floor, cursors: cursors.length };
    }
    case "requeue_github_outbox": {
      const body = closedObject(target, ["outbox_ids"], "github requeue");
      if (
        !Array.isArray(body.outbox_ids) ||
        body.outbox_ids.length < 1 ||
        body.outbox_ids.length > OPS_MAX_TARGETS
      ) {
        fail("invalid_argument", "outbox_ids must list 1 to 50 ids");
      }
      const ids = body.outbox_ids as unknown[];
      for (const id of ids) {
        if (typeof id !== "string" || id.length < 8 || id.length > 128) {
          fail("invalid_argument", "outbox ids must be bounded strings");
        }
      }
      const queues = ids as string[];
      for (const id of queues) {
        const row = (await db
          .prepare(
            `SELECT state FROM github_integration_outbox WHERE workspace_id = ? AND outbox_id = ?`,
          )
          .get(workspaceId, id)) as { state: string } | undefined;
        if (!row) {
          fail("invalid_argument", `github outbox row ${id} does not exist`);
        }
        if (row.state !== "dlq" && row.state !== "dispatched") {
          fail(
            "invalid_argument",
            `github outbox row ${id} in state ${row.state} needs no requeue`,
          );
        }
      }
      let requeued = 0;
      for (const id of queues) {
        await db
          .prepare(
            `UPDATE github_integration_outbox
             SET state = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL, updated_at = ?
             WHERE workspace_id = ? AND outbox_id = ? AND state IN ('dlq', 'dispatched')`,
          )
          .run(now, now, workspaceId, id);
        requeued += 1;
      }
      return { requeued };
    }
    case "resolve_stuck_upload": {
      fail("request_rejected", "upload recovery requires WorkspaceHub");
    }
    case "clear_recovery_state": {
      const body = closedObject(target, ["action_ids"], "recovery clearing");
      if (
        !Array.isArray(body.action_ids) ||
        body.action_ids.length < 1 ||
        body.action_ids.length > OPS_MAX_TARGETS
      ) {
        fail("invalid_argument", "action_ids must list 1 to 50 ids");
      }
      let cleared = 0;
      for (const id of body.action_ids as unknown[]) {
        if (typeof id !== "string" || id.length < 8 || id.length > 128) {
          fail("invalid_argument", "action ids must be bounded strings");
        }
        const result = await db
          .prepare(`DELETE FROM ops_recovery_ledger WHERE workspace_id = ? AND action_id = ?`)
          .run(workspaceId, id);
        cleared += Number(result.changes ?? 0);
      }
      return { cleared };
    }
  }
}

export type OpsQueueMessage =
  | {
      schema_version: 1;
      kind: "diagnostic.upload";
      workspace_id: string;
      bundle_id: string;
      attempt: number;
    }
  | { schema_version: 1; kind: "retention.sweep"; workspace_id: string; attempt: number };

/** Stable job identity so consented-upload redelivery converges. */
export function opsJobId(workspaceId: string, bundleId: string): string {
  return `x05:${workspaceId}:${bundleId}`;
}

/** Server-derived R2 key for an uploaded diagnostic bundle. Callers never select keys. */
export function diagnosticR2Key(workspaceId: string, bundleId: string): string {
  return `workspaces/${workspaceId}/diagnostics/${bundleId}.json`;
}

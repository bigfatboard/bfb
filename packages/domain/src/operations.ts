// ABOUTME: Owner-gated operations read models, retention policy, diagnostics, and privileged recovery.
// ABOUTME: Security audit and activity stay distinct; retention never deletes hashes, metadata, or blobs.

import { createHash } from "node:crypto";

import type { SqlDatabase } from "@bfb/db";

import { assertEpoch, assertRole, loadPrincipal } from "./authorization.js";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { isUlid, randomUlid } from "./ids.js";
import { validateStepUpProof, type StepUpAction } from "./step-up.js";

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
    const check = (await ctx.db
      .prepare(`SELECT COUNT(*) AS count FROM passkey_step_up_proofs WHERE proof_id = ? AND consumed_at = ?`)
      .get(proofId, stamp)) as { count: number };
    if (check.count !== 1) {
      fail("step_up_replayed", "step-up proof lost the consume race");
    }
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

export async function getRetentionPolicy(db: SqlDatabase, workspaceId: string): Promise<RetentionPolicy | null> {
  return (await db
    .prepare(`SELECT * FROM retention_policies WHERE workspace_id = ?`)
    .get(workspaceId)) as RetentionPolicy | null | undefined ?? null;
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
      fail("invalid_argument", `retention window must be ${RETENTION_MIN_DAYS} to ${RETENTION_MAX_DAYS} days`);
    }
    const principal = await requireOwner(ctx);
    const consume = await prepareStepUp(ctx, input.stepUpProofId, OPS_STEP_UP_ACTIONS.retention, `ops-retention:${ctx.workspaceId}`);
    await consume();
    const existing = await getRetentionPolicy(ctx.db, ctx.workspaceId);
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
 */
export async function listRetentionEligibleChunks(
  db: SqlDatabase,
  workspaceId: string,
  nowIso: string,
): Promise<{ cutoff: string; days: number; examined: number; eligible: RetentionCandidate[] }> {
  const policy = await getRetentionPolicy(db, workspaceId);
  const days = policy?.raw_log_retention_days ?? RETENTION_DEFAULT_DAYS;
  const cutoff = retentionCutoff(nowIso, days);
  const rows = (await db
    .prepare(
      `SELECT v.id AS version_id, v.artifact_id, a.run_id, v.r2_key, v.declared_size, v.available_at
       FROM artifact_versions AS v
       JOIN artifacts AS a ON a.workspace_id = v.workspace_id AND a.id = v.artifact_id
       WHERE v.workspace_id = ?
         AND a.role = 'log'
         AND v.state = 'available'
         AND v.r2_key IS NOT NULL
         AND v.r2_key LIKE 'workspaces/%/runs/%/logs/%'
         AND v.r2_key NOT LIKE '%artifacts/sha256/%'`,
    )
    .all(workspaceId)) as Array<{
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
    if (value.length > 256 || SENSITIVE_KEY_PATTERN.test(value)) {
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
  return { schema_version: 1, workspace_id: workspaceId, generated_at: nowIso, generated_by: humanId, sections };
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

export const createDiagnosticBundleCommand: HubCommand<{ stepUpProofId: string }, DiagnosticBundleRecord> = {
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
    const inventory = await buildDiagnosticInventory(ctx.db, ctx.workspaceId, principal.humanId, ctx.now);
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
    if (bundle.state === "pending_consent" && Date.parse(bundle.expires_at) <= Date.parse(ctx.now)) {
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
 */
export async function readSecurityAudit(
  db: SqlDatabase,
  workspaceId: string,
  options: { limit?: number; after?: string } = {},
): Promise<{ entries: SecurityAuditEntry[]; has_more: boolean }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), OPS_MAX_PAGE);
  const rows = (await db
    .prepare(
      `SELECT audit_id, actor_principal_id, action, payload_json, created_at
       FROM audit_events
       WHERE workspace_id = ? ${options.after ? "AND audit_id > ?" : ""}
       ORDER BY audit_id ASC
       LIMIT ?`,
    )
    .all(...(options.after ? [workspaceId, options.after] : [workspaceId]), limit + 1)) as Array<{
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
  options: { limit?: number; afterCursor?: number; projectIds?: string[] } = {},
): Promise<{ entries: ActivityEntry[]; has_more: boolean }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), OPS_MAX_PAGE);
  const params: unknown[] = [workspaceId];
  let extra = "";
  if (options.afterCursor !== undefined) {
    extra += " AND workspace_cursor > ?";
    params.push(options.afterCursor);
  }
  if (options.projectIds !== undefined) {
    if (options.projectIds.length === 0) {
      return { entries: [], has_more: false };
    }
    extra += ` AND project_id IN (${options.projectIds.map(() => "?").join(",")})`;
    params.push(...options.projectIds);
  }
  const rows = (await db
    .prepare(
      `SELECT workspace_cursor, kind, actor_type, actor_id, source_id, source_provider,
              project_id, task_id, run_id, occurred_at, received_at
       FROM event_ledger
       WHERE workspace_id = ? ${extra}
       ORDER BY workspace_cursor ASC
       LIMIT ?`,
    )
    .all(...params, limit + 1)) as ActivityEntry[];
  return { entries: rows.slice(0, limit), has_more: rows.length > limit };
}

export interface StuckUpload {
  version_id: string;
  artifact_id: string;
  created_at: string;
  age_ms: number;
}

/** Uploading versions with no live grant past the grant TTL plus grace. */
export async function listStuckUploads(
  db: SqlDatabase,
  workspaceId: string,
  nowIso: string,
): Promise<StuckUpload[]> {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    return [];
  }
  const rows = (await db
    .prepare(
      `SELECT v.id AS version_id, v.artifact_id, v.created_at
       FROM artifact_versions AS v
       WHERE v.workspace_id = ?
         AND v.state = 'uploading'
         AND datetime(v.created_at) <= datetime(?, '-1200 seconds')
         AND NOT EXISTS (
           SELECT 1 FROM artifact_upload_grants AS g
           WHERE g.workspace_id = v.workspace_id
             AND g.version_id = v.id
             AND g.consumed_at IS NULL
             AND datetime(g.expires_at) > datetime(?)
         )
       ORDER BY v.created_at ASC`,
    )
    .all(workspaceId, nowIso, nowIso)) as Array<{ version_id: string; artifact_id: string; created_at: string }>;
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
): Promise<StuckLaunch[]> {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    return [];
  }
  const rows = (await db
    .prepare(
      `SELECT id AS command_id, run_id, state, expires_at,
              COALESCE(claimed_at, created_at) AS since
       FROM launch_commands
       WHERE workspace_id = ?
         AND ((state = 'pending' AND datetime(expires_at) <= datetime(?))
           OR (state = 'claimed' AND final_authorized_at IS NULL
               AND datetime(COALESCE(claimed_at, created_at)) <= datetime(?, '-600 seconds')))
       ORDER BY since ASC`,
    )
    .all(workspaceId, nowIso, nowIso)) as Array<{
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

export async function readQueueState(db: SqlDatabase, workspaceId: string, nowIso: string): Promise<QueueState> {
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
): Promise<WorkspaceHealth> {
  const nowMs = Date.parse(nowIso);
  const policy = await getRetentionPolicy(db, workspaceId);
  const retentionList = await listRetentionEligibleChunks(db, workspaceId, nowIso);
  const queues = await readQueueState(db, workspaceId, nowIso);
  const stuckUploads = await listStuckUploads(db, workspaceId, nowIso);
  const stuckLaunches = await listStuckLaunches(db, workspaceId, nowIso);
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
      | { revision: number; inventory_json: string; received_at: string }
      | undefined;
    if (!row) {
      providers.push({ runner_id: runner.id, present: false, received_age_ms: null, stale: true, providers: [] });
      continue;
    }
    let parsed: { providers?: Array<{ provider: string; status: string; version?: string; observed_at: string; expires_at: string }> } = {};
    try {
      parsed = JSON.parse(row.inventory_json) as typeof parsed;
    } catch {
      parsed = {};
    }
    const receivedAge = Number.isFinite(nowMs) ? Math.max(0, nowMs - Date.parse(row.received_at)) : null;
    providers.push({
      runner_id: runner.id,
      present: true,
      received_age_ms: receivedAge,
      stale: receivedAge === null || receivedAge > PROVIDER_RECORD_STALE_MS,
      providers: (parsed.providers ?? []).map((entry) => {
        const observedAge =
          Number.isFinite(nowMs) && entry.observed_at ? Math.max(0, nowMs - Date.parse(entry.observed_at)) : null;
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
  return {
    schema_version: 1,
    workspace_id: workspaceId,
    checked_at: nowIso,
    retention: {
      configured: policy !== null,
      days: policy?.raw_log_retention_days ?? RETENTION_DEFAULT_DAYS,
      version: policy?.version ?? null,
      eligible_chunks: retentionList.eligible.length,
    },
    queues,
    launches: { stuck: stuckLaunches },
    uploads: { stuck: stuckUploads },
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

export async function checkOperationsTables(db: SqlDatabase): Promise<{ ok: boolean; missing: string[] }> {
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

/**
 * Applies one privileged recovery idempotently. Retries with an identical
 * target return the stored outcome without touching domain state again.
 * Every effect reuses the owning package's own convergence mechanism:
 * notification redispatch rewinds the X01 watermark, GitHub requeue resets
 * rows the X04 reconciler already converges, and stuck-upload resolution
 * applies the exact V01 abandonment predicate.
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
  const actionId = recoveryActionId(input.kind, input.target);
  const stored = (await db
    .prepare(`SELECT state, result_json, target_json FROM ops_recovery_ledger WHERE workspace_id = ? AND action_id = ?`)
    .get(input.workspaceId, actionId)) as
    | { state: string; result_json: string; target_json: string }
    | undefined;
  if (stored && stored.state === "applied" && stored.target_json === JSON.stringify(input.target)) {
    return {
      action_id: actionId,
      kind: input.kind,
      replayed: true,
      detail: JSON.parse(stored.result_json) as Record<string, number | string>,
    };
  }
  const detail = await runRecoveryEffect(db, input.workspaceId, input.kind, input.target, input.now);
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
      if (!Array.isArray(body.cursors) || body.cursors.length < 1 || body.cursors.length > OPS_MAX_TARGETS) {
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
          .prepare(`SELECT workspace_cursor FROM semantic_events WHERE workspace_id = ? AND workspace_cursor = ?`)
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
      if (!Array.isArray(body.outbox_ids) || body.outbox_ids.length < 1 || body.outbox_ids.length > OPS_MAX_TARGETS) {
        fail("invalid_argument", "outbox_ids must list 1 to 50 ids");
      }
      const ids = body.outbox_ids as unknown[];
      for (const id of ids) {
        if (typeof id !== "string" || id.length < 8 || id.length > 128) {
          fail("invalid_argument", "outbox ids must be bounded strings");
        }
      }
      let requeued = 0;
      for (const id of ids as string[]) {
        const row = (await db
          .prepare(`SELECT state FROM github_integration_outbox WHERE workspace_id = ? AND outbox_id = ?`)
          .get(workspaceId, id)) as { state: string } | undefined;
        if (!row) {
          fail("invalid_argument", `github outbox row ${id} does not exist`);
        }
        if (row.state !== "dlq" && row.state !== "dispatched") {
          fail("invalid_argument", `github outbox row ${id} in state ${row.state} needs no requeue`);
        }
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
      const body = closedObject(target, ["version_ids"], "stuck upload resolution");
      const ids = ulidList(body.version_ids, "version_ids");
      const stuck = await listStuckUploads(db, workspaceId, now);
      const stuckIds = new Set(stuck.map((entry) => entry.version_id));
      for (const id of ids) {
        if (!stuckIds.has(id)) {
          fail("invalid_argument", `artifact version ${id} is not a stuck upload`);
        }
      }
      for (const id of ids) {
        await db
          .prepare(
            `UPDATE artifact_versions SET state = 'failed'
             WHERE workspace_id = ? AND id = ? AND state = 'uploading'`,
          )
          .run(workspaceId, id);
        await db
          .prepare(
            `INSERT INTO artifact_audit_outbox (workspace_id, id, version_id, grant_id, action, payload_json, created_at)
             VALUES (?, ?, ?, NULL, 'artifact.abandoned', ?, ?)`,
          )
          .run(workspaceId, randomUlid(), id, JSON.stringify({ version_id: id }), now);
      }
      return { resolved: ids.length };
    }
    case "clear_recovery_state": {
      const body = closedObject(target, ["action_ids"], "recovery clearing");
      if (!Array.isArray(body.action_ids) || body.action_ids.length < 1 || body.action_ids.length > OPS_MAX_TARGETS) {
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

export interface OpsQueueMessage {
  schema_version: 1;
  kind: "diagnostic.upload";
  workspace_id: string;
  bundle_id: string;
  attempt: number;
}

/** Stable job identity so consented-upload redelivery converges. */
export function opsJobId(workspaceId: string, bundleId: string): string {
  return `x05:${workspaceId}:${bundleId}`;
}

/** Server-derived R2 key for an uploaded diagnostic bundle. Callers never select keys. */
export function diagnosticR2Key(workspaceId: string, bundleId: string): string {
  return `workspaces/${workspaceId}/diagnostics/${bundleId}.json`;
}

// ABOUTME: Selects actionable committed events and derives stable notification delivery identity.
// ABOUTME: Payloads stay untrusted for display; fan-out re-reads D1 for scope before any contact.

import { createHash } from "node:crypto";

import type { SqlDatabase } from "@bfb/db";

import { DomainError, type HubCommand } from "./hub.js";
import { isUlid } from "./ids.js";
import { loadPrincipal } from "./authorization.js";
import { assertCurrentRunnerPrincipal, type RunnerPrincipal } from "./runners.js";

export const NOTIFICATION_CHANNELS = ["browser_push", "macos"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_CATEGORIES = [
  "attention",
  "launch_blocked",
  "run_failed",
  "result_submitted",
  "result_accepted",
  "result_changes_requested",
  "run_cancelled",
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Project scope sentinel meaning workspace-wide preference scope. */
export const NOTIFICATION_WORKSPACE_SCOPE = "*";

export const NOTIFICATION_MAX_RECIPIENTS = 500;
export const NOTIFICATION_MAX_RUNNERS_PER_HUMAN = 25;
export const NOTIFICATION_QUEUE_MAX_ATTEMPTS = 5;
export const NOTIFICATION_JOB_PREFIX = "x01:";

const DEFAULT_ENABLED: Record<NotificationCategory, boolean> = {
  attention: true,
  launch_blocked: true,
  run_failed: true,
  result_submitted: true,
  result_accepted: true,
  result_changes_requested: false,
  run_cancelled: false,
};

export function defaultPreference(category: NotificationCategory): boolean {
  return DEFAULT_ENABLED[category];
}

function isChannel(value: unknown): value is NotificationChannel {
  return value === "browser_push" || value === "macos";
}

function isCategory(value: unknown): value is NotificationCategory {
  return (
    typeof value === "string" && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value)
  );
}

function assertScope(value: unknown): string {
  if (value === NOTIFICATION_WORKSPACE_SCOPE) return NOTIFICATION_WORKSPACE_SCOPE;
  if (typeof value === "string" && isUlid(value)) return value;
  throw new DomainError("invalid_argument", "notification project scope is invalid");
}

export interface NotificationSubject {
  category: NotificationCategory;
  attentionId?: string | undefined;
  launchId?: string | undefined;
  runId?: string | undefined;
  submissionVersion?: number | undefined;
}

function ulidField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && isUlid(value) ? value : null;
}

function resultOf(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const result = (payload as Record<string, unknown>).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  return result as Record<string, unknown>;
}

function inputOf(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const input = (payload as Record<string, unknown>).input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

/**
 * Pure event selection over one committed semantic event. Returns the
 * notification subject or null when the event never notifies. Payloads are
 * untrusted for display: only ULID-typed IDs are extracted, and fan-out
 * re-reads every referent from D1 before any contact.
 */
export function selectNotificationEvent(
  kind: string,
  payload: unknown,
): NotificationSubject | null {
  const result = resultOf(payload);
  const input = inputOf(payload);
  if (!result) return null;
  switch (kind) {
    case "attention.request": {
      if (result.state !== "open") return null;
      const attentionId = ulidField(result, "id");
      if (!attentionId) return null;
      return { category: "attention", attentionId };
    }
    case "launch.reject": {
      const launchId = input ? ulidField(input, "launchId") : null;
      if (!launchId) return null;
      if (result.state !== "rejected" && result.state !== "expired") return null;
      return { category: "launch_blocked", launchId };
    }
    case "launch.claim": {
      const launchId = input ? ulidField(input, "launchId") : null;
      if (!launchId) return null;
      if (
        (result.state === "rejected" || result.state === "expired") &&
        (result.reason === "launch_blocked" || result.reason === "launch_expired")
      ) {
        return { category: "launch_blocked", launchId };
      }
      return null;
    }
    case "launch.authorize": {
      if (result.decision !== "rejected") return null;
      const rejection = result.rejection;
      const code =
        rejection && typeof rejection === "object" && !Array.isArray(rejection)
          ? (rejection as Record<string, unknown>).code
          : null;
      if (code !== "launch_blocked" && code !== "launch_expired") return null;
      const launchId = ulidField(result, "launch_id");
      if (!launchId) return null;
      return { category: "launch_blocked", launchId };
    }
    case "result.submit": {
      if (result.taskState !== "review") return null;
      const submission =
        result.submission && typeof result.submission === "object"
          ? (result.submission as Record<string, unknown>)
          : null;
      const runId = submission ? ulidField(submission, "run_id") : null;
      const version = submission?.version;
      if (!runId || !Number.isSafeInteger(version) || Number(version) < 1) return null;
      return { category: "result_submitted", runId, submissionVersion: Number(version) };
    }
    case "result.request_changes":
    case "result.accept":
    case "result.fail":
    case "result.cancel": {
      const runId = ulidField(result, "run_id") ?? (input ? ulidField(input, "runId") : null);
      if (!runId) return null;
      if (kind === "result.request_changes") {
        if (result.runResultState !== "changes_requested") return null;
        // The review commands return no submission version; fan-out resolves
        // the latest submission for the run from D1 (reviews target latest).
        return { category: "result_changes_requested", runId };
      }
      if (kind === "result.accept") {
        if (result.runResultState !== "accepted") return null;
        return { category: "result_accepted", runId };
      }
      if (kind === "result.fail") {
        if (result.runResultState !== "failed") return null;
        return { category: "run_failed", runId };
      }
      if (result.runResultState !== "cancelled") return null;
      return { category: "run_cancelled", runId };
    }
    default:
      return null;
  }
}

/**
 * Stable delivery identity: retries of one queue message re-derive the same
 * ID, so redelivery converges on one logical effect per channel. The ID is
 * opaque and ULID-shaped so it passes the existing app-bridge validator.
 */
export function deriveDeliveryId(
  workspaceId: string,
  eventCursor: number,
  channel: NotificationChannel,
  recipient: string,
): string {
  const digest = createHash("sha256")
    .update(`x01|${workspaceId}|${eventCursor}|${channel}|${recipient}`, "utf8")
    .digest("hex")
    .toUpperCase()
    .slice(0, 26);
  const first = Number.parseInt(digest[0] ?? "0", 16) % 8;
  return `${first}${digest.slice(1)}`;
}

export function notificationJobId(workspaceId: string, eventCursor: number): string {
  return `${NOTIFICATION_JOB_PREFIX}${workspaceId}:${eventCursor}`;
}

export interface ResolvedSubject {
  projectId: string;
  taskId: string;
  runId?: string | undefined;
  attentionId?: string | undefined;
  launchId?: string | undefined;
  submissionVersion?: number | undefined;
}

export const NOTIFICATION_COPY: Record<NotificationCategory, { title: string; body: string }> = {
  attention: { title: "BFB needs your attention", body: "Open BFB to review the next step." },
  launch_blocked: { title: "BFB launch blocked", body: "Open BFB to review the next step." },
  run_failed: { title: "BFB run failed", body: "Open BFB to review the next step." },
  result_submitted: {
    title: "BFB result ready for review",
    body: "Open BFB to review the next step.",
  },
  result_accepted: { title: "BFB result accepted", body: "Open BFB to review the next step." },
  result_changes_requested: {
    title: "BFB changes requested",
    body: "Open BFB to review the next step.",
  },
  run_cancelled: { title: "BFB run cancelled", body: "Open BFB to review the next step." },
};

export function notificationDeepLink(
  appOrigin: string,
  workspaceId: string,
  subject: ResolvedSubject,
  category: NotificationCategory,
): string {
  const origin = appOrigin.replace(/\/+$/, "");
  const base = `${origin}/w/${workspaceId}/tasks/${subject.taskId}`;
  if (category === "attention" && subject.attentionId) {
    return `${base}/attention/${subject.attentionId}`;
  }
  if (
    (category === "result_submitted" ||
      category === "result_changes_requested" ||
      category === "result_accepted") &&
    subject.runId &&
    subject.submissionVersion !== undefined
  ) {
    return `${base}/runs/${subject.runId}/results/${subject.submissionVersion}`;
  }
  if (subject.runId) {
    return `${base}/runs/${subject.runId}`;
  }
  return base;
}

export interface PushPayload {
  title: string;
  body: string;
  deep_link: string;
  delivery_id: string;
  event_cursor: number;
}

export function buildPushPayload(input: {
  appOrigin: string;
  workspaceId: string;
  subject: ResolvedSubject;
  category: NotificationCategory;
  deliveryId: string;
  eventCursor: number;
}): PushPayload {
  const copy = NOTIFICATION_COPY[input.category];
  return {
    title: copy.title,
    body: copy.body,
    deep_link: notificationDeepLink(
      input.appOrigin,
      input.workspaceId,
      input.subject,
      input.category,
    ),
    delivery_id: input.deliveryId,
    event_cursor: input.eventCursor,
  };
}

export interface PreferenceOverride {
  project_id: string;
  channel: NotificationChannel;
  category: NotificationCategory;
  enabled: boolean;
}

export function resolvePreference(
  overrides: PreferenceOverride[],
  projectId: string,
  channel: NotificationChannel,
  category: NotificationCategory,
): boolean {
  const scoped = overrides.find(
    (entry) =>
      entry.channel === channel && entry.category === category && entry.project_id === projectId,
  );
  if (scoped) return scoped.enabled;
  const wide = overrides.find(
    (entry) =>
      entry.channel === channel &&
      entry.category === category &&
      entry.project_id === NOTIFICATION_WORKSPACE_SCOPE,
  );
  if (wide) return wide.enabled;
  return defaultPreference(category);
}

export interface SetPreferenceInput {
  projectId?: string | undefined;
  channel: NotificationChannel;
  category: NotificationCategory;
  enabled: boolean;
}

export const setNotificationPreferenceCommand: HubCommand<SetPreferenceInput, PreferenceOverride> =
  {
    name: "notification.preference.set",
    auditInput: (input) => ({
      projectId: input.projectId ?? NOTIFICATION_WORKSPACE_SCOPE,
      channel: input.channel,
      category: input.category,
      enabled: input.enabled,
    }),
    async run(input, ctx) {
      if (!ctx.actorHumanId) {
        throw new DomainError("forbidden", "notification preferences need a human actor");
      }
      if (!isChannel(input.channel) || !isCategory(input.category)) {
        throw new DomainError("invalid_argument", "notification channel or category is invalid");
      }
      if (typeof input.enabled !== "boolean") {
        throw new DomainError("invalid_argument", "notification enabled flag is invalid");
      }
      const scope =
        input.projectId === undefined ? NOTIFICATION_WORKSPACE_SCOPE : assertScope(input.projectId);
      const principal = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
      if (scope !== NOTIFICATION_WORKSPACE_SCOPE && !principal.projectIds.includes(scope)) {
        throw new DomainError("not_found", "project not found");
      }
      await ctx.db
        .prepare(
          `INSERT INTO notification_preferences
         (workspace_id, human_id, project_id, channel, category, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, human_id, project_id, channel, category)
         DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
        )
        .run(
          ctx.workspaceId,
          ctx.actorHumanId,
          scope,
          input.channel,
          input.category,
          input.enabled ? 1 : 0,
          ctx.now,
        );
      return {
        project_id: scope,
        channel: input.channel,
        category: input.category,
        enabled: input.enabled,
      };
    },
  };

export const MAX_PUSH_ENDPOINT_CHARS = 2048;

function endpointHash(endpoint: string): string {
  return createHash("sha256").update(endpoint, "utf8").digest("hex");
}

function assertPushEndpoint(input: { endpoint: unknown; p256dh: unknown; auth: unknown }): {
  endpoint: string;
  p256dh: string;
  auth: string;
} {
  const { endpoint, p256dh, auth } = input;
  if (
    typeof endpoint !== "string" ||
    endpoint.length < 9 ||
    endpoint.length > MAX_PUSH_ENDPOINT_CHARS
  ) {
    throw new DomainError("invalid_argument", "push endpoint is invalid");
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new DomainError("invalid_argument", "push endpoint is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new DomainError("invalid_argument", "push endpoint is invalid");
  }
  if (typeof p256dh !== "string" || p256dh.length < 87 || p256dh.length > 88) {
    throw new DomainError("invalid_argument", "push p256dh key is invalid");
  }
  if (typeof auth !== "string" || auth.length < 22 || auth.length > 24) {
    throw new DomainError("invalid_argument", "push auth key is invalid");
  }
  return { endpoint, p256dh, auth };
}

export interface RegisterPushEndpointInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export const registerPushEndpointCommand: HubCommand<
  RegisterPushEndpointInput,
  { endpoint_hash: string }
> = {
  name: "notification.push_endpoint.register",
  auditInput: (input) => ({
    hasEndpoint: typeof input.endpoint === "string" && input.endpoint.length > 0,
  }),
  async run(input, ctx) {
    if (!ctx.actorHumanId) {
      throw new DomainError("forbidden", "push endpoints need a human actor");
    }
    const checked = assertPushEndpoint(input);
    await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
    const hash = endpointHash(checked.endpoint);
    await ctx.db
      .prepare(
        `INSERT INTO notification_push_endpoints
         (workspace_id, human_id, endpoint_hash, endpoint, p256dh, auth, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, human_id, endpoint_hash)
         DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, last_seen_at = excluded.last_seen_at`,
      )
      .run(
        ctx.workspaceId,
        ctx.actorHumanId,
        hash,
        checked.endpoint,
        checked.p256dh,
        checked.auth,
        ctx.now,
        ctx.now,
      );
    return { endpoint_hash: hash };
  },
};

export const removePushEndpointCommand: HubCommand<{ endpointHash: string }, { removed: boolean }> =
  {
    name: "notification.push_endpoint.remove",
    auditInput: (input) => ({ hasEndpointHash: typeof input.endpointHash === "string" }),
    async run(input, ctx) {
      if (!ctx.actorHumanId) {
        throw new DomainError("forbidden", "push endpoints need a human actor");
      }
      if (typeof input.endpointHash !== "string" || !/^[0-9a-f]{64}$/.test(input.endpointHash)) {
        throw new DomainError("invalid_argument", "push endpoint hash is invalid");
      }
      await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
      const existing = (await ctx.db
        .prepare(
          `SELECT endpoint_hash FROM notification_push_endpoints
         WHERE workspace_id = ? AND human_id = ? AND endpoint_hash = ?`,
        )
        .get(ctx.workspaceId, ctx.actorHumanId, input.endpointHash)) as
        { endpoint_hash: string } | undefined;
      if (!existing) {
        return { removed: false };
      }
      await ctx.db
        .prepare(
          `DELETE FROM notification_push_endpoints
         WHERE workspace_id = ? AND human_id = ? AND endpoint_hash = ?`,
        )
        .run(ctx.workspaceId, ctx.actorHumanId, input.endpointHash);
      return { removed: true };
    },
  };

export async function getPreferenceOverrides(
  db: SqlDatabase,
  workspaceId: string,
  humanId: string,
): Promise<PreferenceOverride[]> {
  const rows = (await db
    .prepare(
      `SELECT project_id, channel, category, enabled FROM notification_preferences
       WHERE workspace_id = ? AND human_id = ?`,
    )
    .all(workspaceId, humanId)) as Array<{
    project_id: string;
    channel: string;
    category: string;
    enabled: number;
  }>;
  return rows.flatMap((row) =>
    isChannel(row.channel) && isCategory(row.category)
      ? [
          {
            project_id: row.project_id,
            channel: row.channel,
            category: row.category,
            enabled: row.enabled === 1,
          },
        ]
      : [],
  );
}

export interface PushEndpointSummary {
  endpoint_hash: string;
  created_at: string;
  last_seen_at: string;
}

export async function listPushEndpointSummaries(
  db: SqlDatabase,
  workspaceId: string,
  humanId: string,
): Promise<PushEndpointSummary[]> {
  const rows = (await db
    .prepare(
      `SELECT endpoint_hash, created_at, last_seen_at FROM notification_push_endpoints
       WHERE workspace_id = ? AND human_id = ? ORDER BY created_at ASC`,
    )
    .all(workspaceId, humanId)) as PushEndpointSummary[];
  return rows;
}

export interface DeliveryRecord {
  delivery_id: string;
  channel: NotificationChannel;
  human_id: string;
  runner_id: string | null;
  event_cursor: number;
  event_kind: string;
  category: NotificationCategory;
  state: "pending" | "delivered" | "suppressed" | "failed" | "dead_lettered";
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

export async function listDeliveries(
  db: SqlDatabase,
  workspaceId: string,
  humanId: string,
  limit = 50,
): Promise<DeliveryRecord[]> {
  const bounded = Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? limit : 50;
  const rows = (await db
    .prepare(
      `SELECT delivery_id, channel, human_id, runner_id, event_cursor, event_kind,
              category, state, attempt_count, last_error, created_at, updated_at, delivered_at
       FROM notification_deliveries
       WHERE workspace_id = ? AND human_id = ? ORDER BY event_cursor DESC LIMIT ?`,
    )
    .all(workspaceId, humanId, bounded)) as DeliveryRecord[];
  return rows;
}

interface EligibleHuman {
  human_id: string;
  role: string;
}

async function eligibleHumans(
  db: SqlDatabase,
  workspaceId: string,
  projectId: string,
): Promise<EligibleHuman[]> {
  const rows = (await db
    .prepare(
      `SELECT DISTINCT membership.human_id AS human_id, membership.role AS role
       FROM workspace_members AS membership
       JOIN workspace_authorization_epochs AS epoch
         ON epoch.workspace_id = membership.workspace_id
        AND epoch.human_id = membership.human_id
       JOIN projects AS project ON project.workspace_id = membership.workspace_id
       LEFT JOIN project_access AS access
         ON access.workspace_id = membership.workspace_id
        AND access.project_id = project.id
        AND access.human_id = membership.human_id
       WHERE membership.workspace_id = ?
         AND membership.authorization_epoch = epoch.authorization_epoch
         AND epoch.revoked_at IS NULL
         AND project.id = ?
         AND (project.access_mode = 'workspace' OR access.human_id IS NOT NULL)
       ORDER BY membership.human_id ASC
       LIMIT ${NOTIFICATION_MAX_RECIPIENTS + 1}`,
    )
    .all(workspaceId, projectId)) as EligibleHuman[];
  return rows.slice(0, NOTIFICATION_MAX_RECIPIENTS);
}

async function humanProjectIds(
  db: SqlDatabase,
  workspaceId: string,
  humanId: string,
): Promise<string[] | null> {
  try {
    const principal = await loadPrincipal(db, workspaceId, humanId);
    return principal.projectIds;
  } catch {
    return null;
  }
}

async function resolveSubject(
  db: SqlDatabase,
  workspaceId: string,
  selected: NotificationSubject,
): Promise<ResolvedSubject | null> {
  if (selected.category === "attention" && selected.attentionId) {
    const row = (await db
      .prepare(
        `SELECT id, project_id, task_id, run_id FROM attention_requests
         WHERE workspace_id = ? AND id = ? AND state = 'open'`,
      )
      .get(workspaceId, selected.attentionId)) as
      { id: string; project_id: string; task_id: string; run_id: string } | undefined;
    if (!row) return null;
    return {
      projectId: row.project_id,
      taskId: row.task_id,
      runId: row.run_id,
      attentionId: row.id,
    };
  }
  if (selected.category === "launch_blocked" && selected.launchId) {
    const row = (await db
      .prepare(
        `SELECT command.run_id AS run_id, run.project_id AS project_id, run.task_id AS task_id
         FROM launch_commands AS command
         JOIN runs AS run ON run.workspace_id = command.workspace_id AND run.id = command.run_id
         WHERE command.workspace_id = ? AND command.id = ?`,
      )
      .get(workspaceId, selected.launchId)) as
      { run_id: string; project_id: string; task_id: string } | undefined;
    if (!row) return null;
    return {
      projectId: row.project_id,
      taskId: row.task_id,
      runId: row.run_id,
      launchId: selected.launchId,
    };
  }
  if (selected.runId) {
    const row = (await db
      .prepare(`SELECT id, project_id, task_id FROM runs WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, selected.runId)) as
      { id: string; project_id: string; task_id: string } | undefined;
    if (!row) return null;
    const subject: ResolvedSubject = {
      projectId: row.project_id,
      taskId: row.task_id,
      runId: row.id,
      submissionVersion: selected.submissionVersion,
    };
    if (
      subject.submissionVersion === undefined &&
      (selected.category === "result_changes_requested" || selected.category === "result_accepted")
    ) {
      const latest = (await db
        .prepare(
          `SELECT version FROM result_submissions
           WHERE workspace_id = ? AND run_id = ? ORDER BY version DESC LIMIT 1`,
        )
        .get(workspaceId, row.id)) as { version: number } | undefined;
      if (latest && Number.isSafeInteger(latest.version)) {
        subject.submissionVersion = latest.version;
      }
    }
    return subject;
  }
  return null;
}

export interface FanoutResult {
  status: "notified" | "not_actionable" | "unknown_event" | "subject_gone";
  category?: NotificationCategory | undefined;
  push?: number | undefined;
  macos?: number | undefined;
}

async function insertDelivery(
  db: SqlDatabase,
  input: {
    workspaceId: string;
    deliveryId: string;
    channel: NotificationChannel;
    humanId: string;
    runnerId: string | null;
    eventCursor: number;
    eventKind: string;
    category: NotificationCategory;
    now: string;
  },
): Promise<boolean> {
  const existing = (await db
    .prepare(`SELECT state FROM notification_deliveries WHERE workspace_id = ? AND delivery_id = ?`)
    .get(input.workspaceId, input.deliveryId)) as { state: string } | undefined;
  if (existing) return false;
  await db
    .prepare(
      `INSERT INTO notification_deliveries
       (workspace_id, delivery_id, channel, human_id, runner_id, event_cursor,
        event_kind, category, state, attempt_count, last_error, created_at, updated_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?, NULL)`,
    )
    .run(
      input.workspaceId,
      input.deliveryId,
      input.channel,
      input.humanId,
      input.runnerId,
      input.eventCursor,
      input.eventKind,
      input.category,
      input.now,
      input.now,
    );
  return true;
}

/**
 * Fans one committed semantic event out to per-recipient delivery rows.
 * Idempotent on the stable delivery IDs: duplicate or out-of-order queue
 * delivery converges without a second logical effect per channel.
 */
export async function fanoutNotificationEvent(
  db: SqlDatabase,
  input: { workspaceId: string; eventCursor: number; eventKind: string; now: string },
): Promise<FanoutResult> {
  const stored = (await db
    .prepare(
      `SELECT kind, payload_json FROM semantic_events
       WHERE workspace_id = ? AND workspace_cursor = ?`,
    )
    .get(input.workspaceId, input.eventCursor)) as
    { kind: string; payload_json: string } | undefined;
  if (!stored) return { status: "unknown_event" };
  if (stored.kind !== input.eventKind) return { status: "unknown_event" };
  let payload: unknown;
  try {
    payload = JSON.parse(stored.payload_json) as unknown;
  } catch {
    return { status: "unknown_event" };
  }
  const selected = selectNotificationEvent(stored.kind, payload);
  if (!selected) return { status: "not_actionable" };
  const subject = await resolveSubject(db, input.workspaceId, selected);
  if (!subject) return { status: "subject_gone" };
  const humans = await eligibleHumans(db, input.workspaceId, subject.projectId);
  let push = 0;
  let macos = 0;
  for (const human of humans) {
    const overrides = await getPreferenceOverrides(db, input.workspaceId, human.human_id);
    if (resolvePreference(overrides, subject.projectId, "browser_push", selected.category)) {
      const endpoints = (await db
        .prepare(
          `SELECT endpoint_hash FROM notification_push_endpoints
           WHERE workspace_id = ? AND human_id = ?`,
        )
        .all(input.workspaceId, human.human_id)) as Array<{ endpoint_hash: string }>;
      if (endpoints.length > 0) {
        const created = await insertDelivery(db, {
          workspaceId: input.workspaceId,
          deliveryId: deriveDeliveryId(
            input.workspaceId,
            input.eventCursor,
            "browser_push",
            human.human_id,
          ),
          channel: "browser_push",
          humanId: human.human_id,
          runnerId: null,
          eventCursor: input.eventCursor,
          eventKind: stored.kind,
          category: selected.category,
          now: input.now,
        });
        if (created) push += 1;
      }
    }
    if (resolvePreference(overrides, subject.projectId, "macos", selected.category)) {
      const runners = (await db
        .prepare(
          `SELECT runner.id AS runner_id
           FROM runners AS runner
           JOIN runner_project_grants AS grant
             ON grant.workspace_id = runner.workspace_id AND grant.runner_id = runner.id
           WHERE runner.workspace_id = ? AND runner.owner_human_id = ?
             AND grant.project_id = ? AND runner.revoked_at IS NULL
           ORDER BY runner.id ASC LIMIT ${NOTIFICATION_MAX_RUNNERS_PER_HUMAN}`,
        )
        .all(input.workspaceId, human.human_id, subject.projectId)) as Array<{
        runner_id: string;
      }>;
      for (const runner of runners) {
        const deliveryId = deriveDeliveryId(
          input.workspaceId,
          input.eventCursor,
          "macos",
          runner.runner_id,
        );
        const created = await insertDelivery(db, {
          workspaceId: input.workspaceId,
          deliveryId,
          channel: "macos",
          humanId: human.human_id,
          runnerId: runner.runner_id,
          eventCursor: input.eventCursor,
          eventKind: stored.kind,
          category: selected.category,
          now: input.now,
        });
        if (created) {
          macos += 1;
          await db
            .prepare(
              `INSERT OR IGNORE INTO notification_macos_inbox
               (workspace_id, runner_id, delivery_id, created_at, acked_at)
               VALUES (?, ?, ?, ?, NULL)`,
            )
            .run(input.workspaceId, runner.runner_id, deliveryId, input.now);
          await db
            .prepare(
              `UPDATE notification_deliveries SET state = 'delivered', updated_at = ?, delivered_at = ?
               WHERE workspace_id = ? AND delivery_id = ? AND state = 'pending'`,
            )
            .run(input.now, input.now, input.workspaceId, deliveryId);
        }
      }
    }
  }
  return { status: "notified", category: selected.category, push, macos };
}

export type DeliveryOutcome =
  | { terminal: true; state: "delivered" | "suppressed" | "failed" | "dead_lettered"; code: string }
  | { terminal: false; code: string };

/**
 * Loads one pending push delivery with a fresh access recheck. Returns the
 * endpoint and subject for the sender, or a terminal outcome when no
 * endpoint may be contacted. Never returns task text: the payload carries
 * only fixed copy, IDs, and the deep link.
 */
export async function loadPushAttempt(
  db: SqlDatabase,
  input: { workspaceId: string; deliveryId: string },
): Promise<
  | {
      ok: true;
      delivery: DeliveryRecord;
      endpoint: string;
      p256dh: string;
      auth: string;
      subject: ResolvedSubject;
    }
  | { ok: false; outcome: DeliveryOutcome }
> {
  const delivery = (await db
    .prepare(
      `SELECT delivery_id, channel, human_id, runner_id, event_cursor, event_kind,
              category, state, attempt_count, last_error, created_at, updated_at, delivered_at
       FROM notification_deliveries WHERE workspace_id = ? AND delivery_id = ?`,
    )
    .get(input.workspaceId, input.deliveryId)) as DeliveryRecord | undefined;
  if (!delivery || delivery.channel !== "browser_push" || delivery.state !== "pending") {
    return { ok: false, outcome: { terminal: true, state: "failed", code: "not_pending" } };
  }
  if (!isCategory(delivery.category)) {
    return { ok: false, outcome: { terminal: true, state: "failed", code: "unknown_category" } };
  }
  const projects = await humanProjectIds(db, input.workspaceId, delivery.human_id);
  if (!projects) {
    return { ok: false, outcome: { terminal: true, state: "suppressed", code: "not_member" } };
  }
  const stored = (await db
    .prepare(
      `SELECT kind, payload_json FROM semantic_events
       WHERE workspace_id = ? AND workspace_cursor = ?`,
    )
    .get(input.workspaceId, delivery.event_cursor)) as
    { kind: string; payload_json: string } | undefined;
  if (!stored || stored.kind !== delivery.event_kind) {
    return { ok: false, outcome: { terminal: true, state: "failed", code: "event_gone" } };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(stored.payload_json) as unknown;
  } catch {
    return { ok: false, outcome: { terminal: true, state: "failed", code: "event_gone" } };
  }
  const selected = selectNotificationEvent(stored.kind, payload);
  if (!selected || selected.category !== delivery.category) {
    return { ok: false, outcome: { terminal: true, state: "failed", code: "event_gone" } };
  }
  const subject = await resolveSubject(db, input.workspaceId, selected);
  if (!subject || !projects.includes(subject.projectId)) {
    return { ok: false, outcome: { terminal: true, state: "suppressed", code: "out_of_scope" } };
  }
  const overrides = await getPreferenceOverrides(db, input.workspaceId, delivery.human_id);
  if (!resolvePreference(overrides, subject.projectId, "browser_push", delivery.category)) {
    return { ok: false, outcome: { terminal: true, state: "suppressed", code: "opted_out" } };
  }
  const endpoint = (await db
    .prepare(
      `SELECT endpoint, p256dh, auth FROM notification_push_endpoints
       WHERE workspace_id = ? AND human_id = ? ORDER BY created_at ASC LIMIT 1`,
    )
    .get(input.workspaceId, delivery.human_id)) as
    { endpoint: string; p256dh: string; auth: string } | undefined;
  if (!endpoint) {
    return { ok: false, outcome: { terminal: true, state: "failed", code: "endpoint_gone" } };
  }
  return {
    ok: true,
    delivery,
    endpoint: endpoint.endpoint,
    p256dh: endpoint.p256dh,
    auth: endpoint.auth,
    subject,
  };
}

export async function recordDeliveryOutcome(
  db: SqlDatabase,
  input: {
    workspaceId: string;
    deliveryId: string;
    outcome: DeliveryOutcome;
    now: string;
  },
): Promise<void> {
  if (input.outcome.terminal) {
    const state = input.outcome.state;
    await db
      .prepare(
        `UPDATE notification_deliveries
         SET state = ?, last_error = ?, updated_at = ?,
             delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END
         WHERE workspace_id = ? AND delivery_id = ?`,
      )
      .run(
        state,
        `${state}:${input.outcome.code}`.slice(0, 256),
        input.now,
        state,
        input.now,
        input.workspaceId,
        input.deliveryId,
      );
    return;
  }
  await db
    .prepare(
      `UPDATE notification_deliveries
       SET attempt_count = attempt_count + 1, last_error = ?, updated_at = ?
       WHERE workspace_id = ? AND delivery_id = ?`,
    )
    .run(
      `retryable:${input.outcome.code}`.slice(0, 256),
      input.now,
      input.workspaceId,
      input.deliveryId,
    );
}

export async function deletePushEndpoint(
  db: SqlDatabase,
  workspaceId: string,
  humanId: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM notification_push_endpoints WHERE workspace_id = ? AND human_id = ?`)
    .run(workspaceId, humanId);
}

export interface MacosPullItem {
  delivery_id: string;
}

export async function pullMacosNotifications(
  db: SqlDatabase,
  principal: RunnerPrincipal,
  now: string,
  limit = 25,
): Promise<{
  schema_version: 1;
  workspace_id: string;
  runner_id: string;
  deliveries: MacosPullItem[];
}> {
  const active = await assertCurrentRunnerPrincipal(db, principal, now);
  const bounded = Number.isSafeInteger(limit) && limit >= 1 && limit <= 25 ? limit : 25;
  const rows = (await db
    .prepare(
      `SELECT inbox.delivery_id AS delivery_id
       FROM notification_macos_inbox AS inbox
       JOIN notification_deliveries AS delivery
         ON delivery.workspace_id = inbox.workspace_id AND delivery.delivery_id = inbox.delivery_id
       WHERE inbox.workspace_id = ? AND inbox.runner_id = ? AND inbox.acked_at IS NULL
         AND delivery.state = 'delivered'
       ORDER BY inbox.created_at ASC, inbox.delivery_id ASC LIMIT ?`,
    )
    .all(active.workspaceId, active.runnerId, bounded)) as MacosPullItem[];
  return {
    schema_version: 1,
    workspace_id: active.workspaceId,
    runner_id: active.runnerId,
    deliveries: rows,
  };
}

export async function ackMacosNotifications(
  db: SqlDatabase,
  principal: RunnerPrincipal,
  deliveryIds: string[],
  now: string,
): Promise<{ schema_version: 1; acked: number }> {
  const active = await assertCurrentRunnerPrincipal(db, principal, now);
  if (!Array.isArray(deliveryIds) || deliveryIds.length > 25) {
    throw new DomainError("invalid_argument", "notification acknowledgement batch is invalid");
  }
  let acked = 0;
  for (const id of deliveryIds) {
    if (typeof id !== "string" || id.length !== 26) {
      throw new DomainError("invalid_argument", "notification acknowledgement batch is invalid");
    }
    const result = await db
      .prepare(
        `UPDATE notification_macos_inbox SET acked_at = ?
         WHERE workspace_id = ? AND runner_id = ? AND delivery_id = ? AND acked_at IS NULL`,
      )
      .run(now, active.workspaceId, active.runnerId, id);
    acked += typeof result?.changes === "number" ? (result.changes ?? 0) : 0;
  }
  return { schema_version: 1, acked };
}

/**
 * Purges push endpoints and preference overrides of removed members. This
 * is hygiene only: delivery-time rechecks already refuse revoked humans,
 * so a missed purge can never notify anyone.
 */
export async function purgeRevokedNotificationState(
  db: SqlDatabase,
  workspaceId: string,
): Promise<{ endpoints: number; preferences: number }> {
  const stale = (await db
    .prepare(
      `SELECT DISTINCT source.human_id AS human_id
       FROM (
         SELECT human_id FROM notification_push_endpoints WHERE workspace_id = ?
         UNION
         SELECT human_id FROM notification_preferences WHERE workspace_id = ?
       ) AS source
       LEFT JOIN workspace_members AS membership
         ON membership.workspace_id = ? AND membership.human_id = source.human_id
       LEFT JOIN workspace_authorization_epochs AS epoch
         ON epoch.workspace_id = membership.workspace_id
        AND epoch.human_id = membership.human_id
        AND epoch.authorization_epoch = membership.authorization_epoch
        AND epoch.revoked_at IS NULL
       WHERE membership.human_id IS NULL OR epoch.human_id IS NULL`,
    )
    .all(workspaceId, workspaceId, workspaceId)) as Array<{ human_id: string }>;
  let endpoints = 0;
  let preferences = 0;
  for (const row of stale) {
    const deletedEndpoints = await db
      .prepare(`DELETE FROM notification_push_endpoints WHERE workspace_id = ? AND human_id = ?`)
      .run(workspaceId, row.human_id);
    const deletedPreferences = await db
      .prepare(`DELETE FROM notification_preferences WHERE workspace_id = ? AND human_id = ?`)
      .run(workspaceId, row.human_id);
    endpoints += deletedEndpoints.changes ?? 0;
    preferences += deletedPreferences.changes ?? 0;
  }
  return { endpoints, preferences };
}

/** Removes acked macOS inbox rows older than the retention bound. */
export async function purgeAckedMacosInbox(
  db: SqlDatabase,
  workspaceId: string,
  now: string,
  retentionMs = 7 * 24 * 3_600_000,
): Promise<number> {
  const cutoff = new Date(Date.parse(now) - retentionMs).toISOString();
  if (!Number.isFinite(Date.parse(cutoff))) {
    throw new DomainError("invalid_argument", "purge time is invalid");
  }
  const deleted = (await db
    .prepare(
      `DELETE FROM notification_macos_inbox
       WHERE workspace_id = ? AND acked_at IS NOT NULL AND acked_at < ?`,
    )
    .run(workspaceId, cutoff)) as unknown as { changes?: number };
  return typeof deleted?.changes === "number" ? deleted.changes : 0;
}

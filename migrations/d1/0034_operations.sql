-- ABOUTME: Persists X05 operations state: retention policy, retention runs, diagnostic bundles, recovery ledger.
-- ABOUTME: Retention deletes only per-run raw log R2 objects; D1 hashes, metadata, and shared blobs are never removed.

PRAGMA defer_foreign_keys = ON;

-- One retention policy row per workspace. Only the raw-log window is
-- configurable in v0.1; audit, events, reviews, and artifact versions have no
-- delete path and artifact blobs are never garbage-collected.
CREATE TABLE retention_policies (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  raw_log_retention_days INTEGER NOT NULL CHECK (raw_log_retention_days BETWEEN 1 AND 365),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_by_human_id TEXT NOT NULL REFERENCES humans (id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

-- Bounded history of retention sweep runs. Rows are observations; they never
-- authorize a delete and never carry payload content.
CREATE TABLE retention_runs (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  id TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  examined INTEGER NOT NULL CHECK (examined >= 0),
  deleted_objects INTEGER NOT NULL CHECK (deleted_objects >= 0),
  deleted_bytes INTEGER NOT NULL CHECK (deleted_bytes >= 0),
  skipped INTEGER NOT NULL CHECK (skipped >= 0),
  error TEXT CHECK (error IS NULL OR length(error) BETWEEN 1 AND 128),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE INDEX retention_runs_recent
  ON retention_runs (workspace_id, started_at DESC, id DESC);

-- Diagnostic bundles are explicit, consented, redacted operator snapshots.
-- The inventory lists every included section with field counts; no section
-- carries task bodies, prompts, paths, hook payloads, artifact bytes,
-- terminal output, cookies, or bearer/grant secrets.
CREATE TABLE diagnostic_bundles (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  id TEXT NOT NULL,
  created_by_human_id TEXT NOT NULL REFERENCES humans (id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('pending_consent', 'consented', 'uploaded', 'expired', 'failed')),
  inventory_json TEXT NOT NULL CHECK (json_valid(inventory_json) AND length(inventory_json) BETWEEN 2 AND 8192),
  bundle_hash TEXT NOT NULL CHECK (length(bundle_hash) = 64),
  redaction_status TEXT NOT NULL CHECK (redaction_status IN ('passed', 'failed')),
  r2_key TEXT CHECK (r2_key IS NULL OR length(r2_key) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL,
  consented_at TEXT,
  uploaded_at TEXT,
  expires_at TEXT NOT NULL,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) BETWEEN 1 AND 128),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  CHECK ((state = 'consented' AND consented_at IS NOT NULL) OR (state != 'consented' AND (consented_at IS NULL OR state = 'uploaded'))),
  CHECK ((state = 'uploaded' AND uploaded_at IS NOT NULL AND r2_key IS NOT NULL) OR (state != 'uploaded'))
);

CREATE INDEX diagnostic_bundles_state
  ON diagnostic_bundles (workspace_id, state, expires_at);

-- Idempotent privileged recovery ledger. One row per stable (kind, target)
-- identity: retries of the same recovery converge on one effect and replays
-- return the stored outcome without touching domain state again.
CREATE TABLE ops_recovery_ledger (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  action_id TEXT NOT NULL CHECK (length(action_id) BETWEEN 8 AND 128),
  kind TEXT NOT NULL CHECK (kind IN (
    'retry_notification_dispatch', 'requeue_github_outbox',
    'resolve_stuck_upload', 'clear_recovery_state'
  )),
  target_json TEXT NOT NULL CHECK (json_valid(target_json) AND length(target_json) BETWEEN 2 AND 4096),
  state TEXT NOT NULL CHECK (state IN ('applied', 'failed')),
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 1),
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND length(result_json) BETWEEN 2 AND 4096),
  created_by_human_id TEXT NOT NULL REFERENCES humans (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, action_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

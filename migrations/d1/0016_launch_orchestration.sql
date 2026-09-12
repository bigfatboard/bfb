-- ABOUTME: Persists immutable launch assignments, snapshot lineage, controls and fenced checkout occupancy.
-- ABOUTME: Expiry never releases a reservation; only bound local containment evidence can do so.

PRAGMA defer_foreign_keys = ON;

-- Preserve existing profile/session history while admitting the explicitly enabled synthetic provider.
-- Restore parent rows after the replacement has its canonical name. Copying into the
-- alternate name first leaves SQLite's deferred reference counters unresolved on DROP.
CREATE TABLE agent_profiles_launch_data AS SELECT * FROM agent_profiles;
CREATE TABLE agent_profiles_launch (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'grok', 'fake')),
  model TEXT,
  execution_mode TEXT NOT NULL DEFAULT 'interactive' CHECK (execution_mode IN ('interactive', 'headless')),
  harness_mode TEXT NOT NULL DEFAULT 'standard' CHECK (harness_mode IN ('restricted', 'standard')),
  resource_version INTEGER NOT NULL DEFAULT 1 CHECK (resource_version >= 1),
  PRIMARY KEY (workspace_id, id),
  CHECK (provider != 'fake' OR (model IS NOT NULL AND model = 'synthetic')),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);
DROP TABLE agent_profiles;
ALTER TABLE agent_profiles_launch RENAME TO agent_profiles;
INSERT INTO agent_profiles SELECT * FROM agent_profiles_launch_data;
DROP TABLE agent_profiles_launch_data;
CREATE UNIQUE INDEX agent_profiles_name_unique ON agent_profiles (workspace_id, name);
CREATE TRIGGER agent_profiles_identity_immutable
BEFORE UPDATE OF id ON agent_profiles WHEN NEW.id IS NOT OLD.id BEGIN
  SELECT RAISE(ABORT, 'agent profile id is immutable');
END;

CREATE TABLE agent_profile_versions_launch_data AS SELECT * FROM agent_profile_versions;
CREATE TABLE agent_profile_versions_launch (
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'grok', 'fake')),
  model TEXT,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('interactive', 'headless')),
  harness_mode TEXT NOT NULL CHECK (harness_mode IN ('restricted', 'standard')),
  created_by_human_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, profile_id, version),
  CHECK (provider != 'fake' OR (model IS NOT NULL AND model = 'synthetic')),
  FOREIGN KEY (workspace_id, profile_id) REFERENCES agent_profiles (workspace_id, id),
  FOREIGN KEY (created_by_human_id) REFERENCES humans (id)
);
DROP TABLE agent_profile_versions;
ALTER TABLE agent_profile_versions_launch RENAME TO agent_profile_versions;
INSERT INTO agent_profile_versions SELECT * FROM agent_profile_versions_launch_data;
DROP TABLE agent_profile_versions_launch_data;
CREATE TRIGGER agent_profile_versions_immutable_update
BEFORE UPDATE ON agent_profile_versions BEGIN
  SELECT RAISE(ABORT, 'agent profile versions are immutable');
END;
CREATE TRIGGER agent_profile_versions_immutable_delete
BEFORE DELETE ON agent_profile_versions BEGIN
  SELECT RAISE(ABORT, 'agent profile versions are immutable');
END;

CREATE TABLE provider_sessions_launch (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'grok', 'fake')),
  requested_session_id TEXT,
  observed_session_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('active', 'ended')),
  resource_version INTEGER NOT NULL DEFAULT 1 CHECK (resource_version >= 1),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  PRIMARY KEY (workspace_id, id),
  CHECK ((state = 'ended' AND ended_at IS NOT NULL) OR (state = 'active' AND ended_at IS NULL)),
  FOREIGN KEY (workspace_id, run_id, execution_id) REFERENCES run_executions (workspace_id, run_id, id)
);
INSERT INTO provider_sessions_launch SELECT * FROM provider_sessions;
DROP TABLE provider_sessions;
ALTER TABLE provider_sessions_launch RENAME TO provider_sessions;

CREATE TABLE run_configuration_snapshots_launch (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  workspace_policy_version INTEGER NOT NULL,
  project_policy_version INTEGER NOT NULL,
  repository_config_version INTEGER NOT NULL,
  agent_profile_id TEXT NOT NULL,
  agent_profile_version INTEGER NOT NULL,
  canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),
  content_hash TEXT NOT NULL CHECK (content_hash GLOB 'sha256:[0-9a-f]*' AND length(content_hash) = 71),
  created_at TEXT NOT NULL,
  snapshot_generation INTEGER NOT NULL DEFAULT 1 CHECK (snapshot_generation >= 1),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, run_id, id),
  UNIQUE (workspace_id, run_id, snapshot_generation),
  FOREIGN KEY (workspace_id, project_id, run_id) REFERENCES runs (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, workspace_policy_version) REFERENCES workspace_policy_versions (workspace_id, version),
  FOREIGN KEY (workspace_id, project_id, project_policy_version) REFERENCES project_policy_versions (workspace_id, project_id, version),
  FOREIGN KEY (workspace_id, project_id, repository_config_version) REFERENCES repository_config_versions (workspace_id, project_id, version),
  FOREIGN KEY (workspace_id, agent_profile_id, agent_profile_version) REFERENCES agent_profile_versions (workspace_id, profile_id, version)
);
INSERT INTO run_configuration_snapshots_launch SELECT *, 1 FROM run_configuration_snapshots;
DROP TABLE run_configuration_snapshots;
ALTER TABLE run_configuration_snapshots_launch RENAME TO run_configuration_snapshots;
CREATE TRIGGER run_configuration_snapshots_immutable_update
BEFORE UPDATE ON run_configuration_snapshots BEGIN
  SELECT RAISE(ABORT, 'run configuration snapshots are immutable');
END;
CREATE TRIGGER run_configuration_snapshots_immutable_delete
BEFORE DELETE ON run_configuration_snapshots BEGIN
  SELECT RAISE(ABORT, 'run configuration snapshots are immutable');
END;

CREATE TABLE execution_assignments (
  workspace_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  assignment_generation INTEGER NOT NULL CHECK (assignment_generation >= 1),
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  physical_worktree_hash TEXT NOT NULL CHECK (length(physical_worktree_hash) = 71),
  requesting_human_id TEXT NOT NULL REFERENCES humans (id),
  requesting_human_epoch INTEGER NOT NULL CHECK (requesting_human_epoch >= 1),
  runner_authorization_epoch INTEGER NOT NULL CHECK (runner_authorization_epoch >= 1),
  runner_grant_epoch INTEGER NOT NULL CHECK (runner_grant_epoch >= 1),
  runner_key_thumbprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, execution_id, assignment_generation),
  UNIQUE (workspace_id, execution_id),
  UNIQUE (workspace_id, execution_id, assignment_generation, runner_id),
  UNIQUE (workspace_id, run_id, assignment_generation),
  FOREIGN KEY (workspace_id, run_id, execution_id) REFERENCES run_executions (workspace_id, run_id, id),
  FOREIGN KEY (workspace_id, run_id, task_id) REFERENCES runs (workspace_id, id, task_id),
  FOREIGN KEY (workspace_id, project_id, run_id) REFERENCES runs (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, runner_id) REFERENCES runners (workspace_id, id)
);
CREATE TRIGGER execution_assignments_immutable_update
BEFORE UPDATE ON execution_assignments BEGIN
  SELECT RAISE(ABORT, 'execution assignments are immutable');
END;
CREATE TRIGGER execution_assignments_immutable_delete
BEFORE DELETE ON execution_assignments BEGIN
  SELECT RAISE(ABORT, 'execution assignments are immutable');
END;

CREATE TABLE launch_commands (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  assignment_generation INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  requesting_human_id TEXT NOT NULL REFERENCES humans (id),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'started', 'rejected', 'expired')),
  snapshot_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  claim_key_hash TEXT CHECK (claim_key_hash IS NULL OR length(claim_key_hash) = 64),
  final_authorized_at TEXT,
  final_identity_json TEXT CHECK (final_identity_json IS NULL OR json_valid(final_identity_json)),
  cancelled_at TEXT,
  end_reason TEXT CHECK (end_reason IN ('launch_blocked', 'launch_expired', 'terminated')),
  resume_session_id TEXT,
  resume_observed_session_id TEXT,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, execution_id),
  UNIQUE (workspace_id, requesting_human_id, idempotency_key_hash),
  FOREIGN KEY (workspace_id, execution_id, assignment_generation) REFERENCES execution_assignments (workspace_id, execution_id, assignment_generation),
  FOREIGN KEY (workspace_id, run_id, execution_id) REFERENCES run_executions (workspace_id, run_id, id),
  FOREIGN KEY (workspace_id, run_id, snapshot_id) REFERENCES run_configuration_snapshots (workspace_id, run_id, id),
  FOREIGN KEY (workspace_id, resume_session_id) REFERENCES provider_sessions (workspace_id, id),
  CHECK ((resume_session_id IS NULL AND resume_observed_session_id IS NULL) OR
    (resume_session_id IS NOT NULL AND resume_observed_session_id IS NOT NULL))
);
CREATE INDEX launch_commands_pending ON launch_commands (workspace_id, state, expires_at);
CREATE TRIGGER launch_commands_binding_immutable
BEFORE UPDATE OF workspace_id, id, execution_id, assignment_generation, run_id,
  requesting_human_id, idempotency_key_hash, request_hash, created_at, expires_at, resume_session_id, resume_observed_session_id
ON launch_commands BEGIN
  SELECT RAISE(ABORT, 'launch command bindings are immutable');
END;

CREATE TABLE checkout_leases (
  workspace_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  physical_worktree_hash TEXT NOT NULL CHECK (length(physical_worktree_hash) = 71),
  execution_id TEXT NOT NULL,
  assignment_generation INTEGER NOT NULL,
  fencing_generation INTEGER NOT NULL CHECK (fencing_generation >= 1),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'live', 'containment_unknown', 'released')),
  expires_at TEXT NOT NULL,
  observation_sequence INTEGER NOT NULL DEFAULT 0 CHECK (observation_sequence >= 0),
  observed_at TEXT,
  identity_json TEXT CHECK (identity_json IS NULL OR json_valid(identity_json)),
  containment_reason TEXT CHECK (containment_reason IN ('escaped_descendant', 'identity_ambiguous', 'evidence_missing', 'recovery_incomplete')),
  released_at TEXT,
  PRIMARY KEY (workspace_id, runner_id, physical_worktree_hash),
  UNIQUE (runner_id, physical_worktree_hash),
  CHECK ((state = 'released' AND released_at IS NOT NULL) OR (state != 'released' AND released_at IS NULL)),
  CHECK ((state = 'containment_unknown' AND containment_reason IS NOT NULL) OR (state != 'containment_unknown' AND containment_reason IS NULL)),
  FOREIGN KEY (workspace_id, runner_id) REFERENCES runners (workspace_id, id),
  FOREIGN KEY (workspace_id, execution_id, assignment_generation, runner_id) REFERENCES execution_assignments (workspace_id, execution_id, assignment_generation, runner_id)
);

CREATE TABLE run_controls (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  assignment_generation INTEGER NOT NULL,
  runner_id TEXT NOT NULL,
  requesting_human_id TEXT NOT NULL REFERENCES humans (id),
  requesting_human_epoch INTEGER NOT NULL CHECK (requesting_human_epoch >= 1),
  runner_authorization_epoch INTEGER NOT NULL CHECK (runner_authorization_epoch >= 1),
  runner_grant_epoch INTEGER NOT NULL CHECK (runner_grant_epoch >= 1),
  runner_key_thumbprint TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('focus_existing', 'resume', 'interrupt', 'terminate', 'cancel')),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'applied', 'rejected', 'expired')),
  claim_key_hash TEXT CHECK (claim_key_hash IS NULL OR length(claim_key_hash) = 64),
  disposition TEXT CHECK (disposition IN ('applied', 'already_applied', 'local_rejected', 'delivery_unknown', 'authorization_lost', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  disposed_at TEXT,
  resume_launch_id TEXT,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, requesting_human_id, idempotency_key_hash),
  FOREIGN KEY (workspace_id, runner_id) REFERENCES runners (workspace_id, id),
  FOREIGN KEY (workspace_id, resume_launch_id) REFERENCES launch_commands (workspace_id, id),
  FOREIGN KEY (workspace_id, execution_id, assignment_generation, runner_id) REFERENCES execution_assignments (workspace_id, execution_id, assignment_generation, runner_id)
);
CREATE TRIGGER run_controls_binding_immutable
BEFORE UPDATE OF workspace_id, id, execution_id, assignment_generation, runner_id,
  requesting_human_id, requesting_human_epoch, runner_authorization_epoch, runner_grant_epoch, runner_key_thumbprint, action, idempotency_key_hash,
  request_hash, created_at, expires_at ON run_controls BEGIN
  SELECT RAISE(ABORT, 'run control bindings are immutable');
END;

CREATE TABLE launch_wake_intents (
  workspace_id TEXT NOT NULL,
  verifier TEXT NOT NULL CHECK (length(verifier) = 64),
  launch_id TEXT NOT NULL,
  requesting_human_id TEXT NOT NULL REFERENCES humans (id),
  requesting_human_epoch INTEGER NOT NULL,
  runner_id TEXT NOT NULL,
  runner_key_thumbprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (workspace_id, verifier),
  UNIQUE (verifier),
  FOREIGN KEY (workspace_id, launch_id) REFERENCES launch_commands (workspace_id, id),
  FOREIGN KEY (workspace_id, runner_id) REFERENCES runners (workspace_id, id)
);
CREATE INDEX launch_wake_intents_expiry ON launch_wake_intents (workspace_id, expires_at);

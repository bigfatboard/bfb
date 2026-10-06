-- ABOUTME: Retains canonical agent publication identities and exact verified-upload source associations.
-- ABOUTME: Immutable additive sidecars preserve historical human artifacts, grants and receipts without invented backfill.

CREATE UNIQUE INDEX artifact_upload_consumptions_exact_identity
ON artifact_upload_consumptions (workspace_id, grant_id, attempt_id);

CREATE TABLE artifact_upload_receipt_sources (
  workspace_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  outbox_id TEXT NOT NULL UNIQUE,
  verified_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, version_id),
  FOREIGN KEY (workspace_id, version_id)
    REFERENCES artifact_upload_receipts (workspace_id, version_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, grant_id, attempt_id)
    REFERENCES artifact_upload_consumptions (workspace_id, grant_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, outbox_id)
    REFERENCES artifact_audit_outbox (workspace_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER artifact_upload_receipt_sources_match BEFORE INSERT ON artifact_upload_receipt_sources
WHEN NOT EXISTS (
  SELECT 1 FROM artifact_upload_grants AS g
  JOIN artifact_upload_consumptions AS c ON c.workspace_id = g.workspace_id AND c.grant_id = g.id
  JOIN artifact_upload_receipts AS receipt ON receipt.workspace_id = g.workspace_id AND receipt.version_id = g.version_id
  WHERE g.workspace_id = NEW.workspace_id AND g.id = NEW.grant_id AND g.version_id = NEW.version_id
    AND c.attempt_id = NEW.attempt_id AND c.consumed_at = g.consumed_at
    AND receipt.content_hash = g.expected_digest AND receipt.size = g.declared_size
) BEGIN SELECT RAISE(ABORT, 'artifact receipt must match its successful consume'); END;
CREATE TRIGGER artifact_upload_receipt_sources_immutable_update BEFORE UPDATE ON artifact_upload_receipt_sources
BEGIN SELECT RAISE(ABORT, 'artifact receipt sources are immutable'); END;
CREATE TRIGGER artifact_upload_receipt_sources_immutable_delete BEFORE DELETE ON artifact_upload_receipt_sources
BEGIN SELECT RAISE(ABORT, 'artifact receipt sources are immutable history'); END;

CREATE TABLE artifact_agent_operations (
  workspace_id TEXT NOT NULL,
  operation_key TEXT NOT NULL CHECK (length(operation_key) = 70 AND substr(operation_key, 1, 6) = 'agent:'
    AND substr(operation_key, 7) NOT GLOB '*[^0-9a-f]*'),
  input_fingerprint TEXT NOT NULL CHECK (length(input_fingerprint) = 64 AND input_fingerprint NOT GLOB '*[^0-9a-f]*'),
  artifact_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  assignment_generation INTEGER NOT NULL CHECK (assignment_generation >= 1),
  provider_session_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  source_task_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, operation_key),
  UNIQUE (workspace_id, version_id),
  UNIQUE (workspace_id, operation_key, version_id),
  FOREIGN KEY (workspace_id, version_id) REFERENCES artifact_versions (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES artifacts (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, execution_id, assignment_generation, run_id, source_task_id, project_id, runner_id)
    REFERENCES execution_assignments (workspace_id, execution_id, assignment_generation, run_id, task_id, project_id, runner_id),
  FOREIGN KEY (workspace_id, execution_id, assignment_generation, run_id, provider_session_id, project_id, source_task_id)
    REFERENCES execution_session_bindings (workspace_id, execution_id, assignment_generation, run_id, provider_session_id, project_id, source_task_id)
);
CREATE TRIGGER artifact_agent_operations_match BEFORE INSERT ON artifact_agent_operations
WHEN NOT EXISTS (
  SELECT 1 FROM artifact_versions AS v JOIN artifacts AS a ON a.workspace_id = v.workspace_id AND a.id = v.artifact_id
  WHERE v.workspace_id = NEW.workspace_id AND v.id = NEW.version_id AND v.artifact_id = NEW.artifact_id
    AND a.run_id = NEW.run_id
) BEGIN SELECT RAISE(ABORT, 'agent publication must match its artifact version and run'); END;
CREATE TRIGGER artifact_agent_operations_immutable_update BEFORE UPDATE ON artifact_agent_operations
BEGIN SELECT RAISE(ABORT, 'agent artifact operations are immutable'); END;
CREATE TRIGGER artifact_agent_operations_immutable_delete BEFORE DELETE ON artifact_agent_operations
BEGIN SELECT RAISE(ABORT, 'agent artifact operations are immutable history'); END;

CREATE TABLE artifact_agent_grants (
  workspace_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  version_id TEXT NOT NULL,
  principal_json TEXT NOT NULL CHECK (json_valid(principal_json) AND json_type(principal_json) = 'object'),
  PRIMARY KEY (workspace_id, grant_id),
  FOREIGN KEY (workspace_id, grant_id) REFERENCES artifact_upload_grants (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, operation_key, version_id)
    REFERENCES artifact_agent_operations (workspace_id, operation_key, version_id) ON DELETE RESTRICT
);
CREATE TRIGGER artifact_agent_grants_match BEFORE INSERT ON artifact_agent_grants
WHEN NOT EXISTS (
  SELECT 1 FROM artifact_upload_grants AS g JOIN artifact_agent_operations AS op
    ON op.workspace_id = g.workspace_id AND op.version_id = g.version_id
  WHERE g.workspace_id = NEW.workspace_id AND g.id = NEW.grant_id AND g.version_id = NEW.version_id
    AND op.operation_key = NEW.operation_key AND g.run_id = op.run_id AND g.human_id IS NULL
    AND json_extract(NEW.principal_json, '$.kind') = 'runner'
    AND json_extract(NEW.principal_json, '$.workspaceId') = op.workspace_id
    AND json_extract(NEW.principal_json, '$.runnerId') = op.runner_id
    AND json_extract(NEW.principal_json, '$.authorizationEpoch') = g.authorization_epoch
) BEGIN SELECT RAISE(ABORT, 'agent grant must match its publication and runner source'); END;
CREATE TRIGGER artifact_agent_grants_immutable_update BEFORE UPDATE ON artifact_agent_grants
BEGIN SELECT RAISE(ABORT, 'agent artifact grants are immutable'); END;
CREATE TRIGGER artifact_agent_grants_immutable_delete BEFORE DELETE ON artifact_agent_grants
BEGIN SELECT RAISE(ABORT, 'agent artifact grants are immutable history'); END;

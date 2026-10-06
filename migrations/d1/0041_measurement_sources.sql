-- ABOUTME: Binds typed telemetry events to immutable semantic measurement sources and execution provenance.
-- ABOUTME: Retains legacy observations unchanged while preventing duplicate activity phases or token facts.

CREATE UNIQUE INDEX event_ledger_measurement_binding
  ON event_ledger (workspace_id, event_id, run_id, run_execution_id, assignment_generation, source_id);

CREATE TABLE measurement_sources (
  workspace_id TEXT NOT NULL,
  source_key TEXT NOT NULL CHECK (length(source_key) = 64 AND source_key NOT GLOB '*[^0-9a-f]*'),
  event_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  run_execution_id TEXT NOT NULL,
  assignment_generation INTEGER NOT NULL CHECK (typeof(assignment_generation) = 'integer' AND assignment_generation >= 1),
  runner_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'grok', 'fake')),
  provider_session_id TEXT,
  family TEXT NOT NULL CHECK (family IN ('turn', 'tool', 'tokens')),
  identity TEXT NOT NULL CHECK (length(identity) BETWEEN 1 AND 128),
  phase TEXT NOT NULL CHECK (phase IN ('start', 'end', 'turn_delta')),
  parent_turn_id TEXT CHECK (parent_turn_id IS NULL OR length(parent_turn_id) BETWEEN 1 AND 128),
  semantic_fingerprint TEXT NOT NULL CHECK (length(semantic_fingerprint) = 64 AND semantic_fingerprint NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (workspace_id, source_key),
  UNIQUE (workspace_id, event_id),
  FOREIGN KEY (workspace_id, event_id) REFERENCES event_ledger (workspace_id, event_id),
  FOREIGN KEY (workspace_id, event_id, run_id, run_execution_id, assignment_generation, runner_id)
    REFERENCES event_ledger (workspace_id, event_id, run_id, run_execution_id, assignment_generation, source_id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs (workspace_id, id),
  FOREIGN KEY (workspace_id, run_execution_id, assignment_generation, runner_id)
    REFERENCES execution_assignments (workspace_id, execution_id, assignment_generation, runner_id),
  CHECK ((family = 'tokens' AND phase = 'turn_delta' AND parent_turn_id IS NULL)
    OR (family IN ('turn', 'tool') AND phase IN ('start', 'end'))),
  CHECK (family = 'tool' OR parent_turn_id IS NULL)
);
CREATE INDEX measurement_sources_run ON measurement_sources (workspace_id, run_id, event_id);
CREATE UNIQUE INDEX measurement_sources_identity ON measurement_sources
  (workspace_id, run_execution_id, assignment_generation, COALESCE(provider_session_id, ''), family, identity, phase);
CREATE TRIGGER measurement_sources_immutable_update BEFORE UPDATE ON measurement_sources BEGIN
  SELECT RAISE(ABORT, 'measurement sources are immutable');
END;
CREATE TRIGGER measurement_sources_immutable_delete BEFORE DELETE ON measurement_sources BEGIN
  SELECT RAISE(ABORT, 'measurement sources cannot be deleted');
END;

CREATE TABLE measurement_event_sources (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  canonical_event_id TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL CHECK (length(input_fingerprint) = 64 AND input_fingerprint NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (workspace_id, event_id),
  FOREIGN KEY (workspace_id, event_id) REFERENCES event_ledger (workspace_id, event_id),
  FOREIGN KEY (workspace_id, canonical_event_id) REFERENCES measurement_sources (workspace_id, event_id)
);
CREATE TRIGGER measurement_event_sources_scope BEFORE INSERT ON measurement_event_sources
WHEN NOT EXISTS (
  SELECT 1 FROM event_ledger e JOIN measurement_sources s
    ON s.workspace_id = NEW.workspace_id AND s.event_id = NEW.canonical_event_id
  WHERE e.workspace_id = NEW.workspace_id AND e.event_id = NEW.event_id
    AND e.run_execution_id = s.run_execution_id AND e.assignment_generation = s.assignment_generation
    AND e.provider_session_id IS s.provider_session_id AND e.source_id = s.runner_id
) BEGIN
  SELECT RAISE(ABORT, 'measurement alias scope differs from canonical source');
END;
CREATE TRIGGER measurement_event_sources_immutable_update BEFORE UPDATE ON measurement_event_sources BEGIN
  SELECT RAISE(ABORT, 'measurement event sources are immutable');
END;
CREATE TRIGGER measurement_event_sources_immutable_delete BEFORE DELETE ON measurement_event_sources BEGIN
  SELECT RAISE(ABORT, 'measurement event sources cannot be deleted');
END;

-- ABOUTME: Stores uniquely identified A04 token, interval, review-timer, and browser-activity observations.
-- ABOUTME: Totals derive at read time from unique identities; observation rows are immutable like the event ledger.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE token_observations (
  workspace_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  run_execution_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'grok', 'fake')),
  model TEXT CHECK (model IS NULL OR (length(model) >= 1 AND length(model) <= 128)),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  quality TEXT NOT NULL CHECK (quality IN ('provider_reported', 'stream_derived', 'estimated', 'unavailable')),
  provenance TEXT NOT NULL CHECK (provenance IN ('runner_observed', 'agent_reported', 'hook_inbox')),
  occurred_at TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, observation_id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs (workspace_id, id),
  CHECK (
    (quality = 'unavailable'
      AND input_tokens IS NULL AND output_tokens IS NULL
      AND cache_read_tokens IS NULL AND cache_write_tokens IS NULL
      AND reasoning_tokens IS NULL)
    OR (quality != 'unavailable'
      AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL
        OR cache_read_tokens IS NOT NULL OR cache_write_tokens IS NOT NULL
        OR reasoning_tokens IS NOT NULL))
  )
);
CREATE TRIGGER token_observations_immutable_update
BEFORE UPDATE ON token_observations BEGIN
  SELECT RAISE(ABORT, 'token observations are immutable');
END;
CREATE TRIGGER token_observations_immutable_delete
BEFORE DELETE ON token_observations BEGIN
  SELECT RAISE(ABORT, 'token observations cannot be deleted');
END;

CREATE INDEX token_observations_run
  ON token_observations (workspace_id, run_id, occurred_at ASC, observation_id ASC);

CREATE TABLE measurement_intervals (
  workspace_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  run_execution_id TEXT NOT NULL,
  interval_kind TEXT NOT NULL CHECK (interval_kind IN ('process_alive', 'active', 'external_wait', 'idle')),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('runner_observed', 'agent_reported', 'hook_inbox')),
  occurred_at TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, observation_id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs (workspace_id, id),
  CHECK (ended_at > started_at)
);
CREATE TRIGGER measurement_intervals_immutable_update
BEFORE UPDATE ON measurement_intervals BEGIN
  SELECT RAISE(ABORT, 'measurement intervals are immutable');
END;
CREATE TRIGGER measurement_intervals_immutable_delete
BEFORE DELETE ON measurement_intervals BEGIN
  SELECT RAISE(ABORT, 'measurement intervals cannot be deleted');
END;

CREATE INDEX measurement_intervals_run
  ON measurement_intervals (workspace_id, run_id, interval_kind, started_at ASC, observation_id ASC);

CREATE TABLE review_timers (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT,
  started_by_human_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'stopped')),
  resource_version INTEGER NOT NULL CHECK (resource_version >= 1),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id),
  FOREIGN KEY (started_by_human_id) REFERENCES humans (id),
  CHECK ((state = 'open' AND stopped_at IS NULL) OR (state = 'stopped' AND stopped_at IS NOT NULL)),
  CHECK (stopped_at IS NULL OR stopped_at >= started_at)
);

CREATE UNIQUE INDEX review_timers_one_open_per_task_human
  ON review_timers (workspace_id, task_id, started_by_human_id)
  WHERE state = 'open';

CREATE TABLE review_timer_observations (
  workspace_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  timer_id TEXT NOT NULL,
  observed_kind TEXT NOT NULL CHECK (observed_kind IN ('started', 'stopped')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human')),
  actor_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, observation_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (workspace_id, timer_id) REFERENCES review_timers (workspace_id, id)
);
CREATE TRIGGER review_timer_observations_immutable_update
BEFORE UPDATE ON review_timer_observations BEGIN
  SELECT RAISE(ABORT, 'review timer observations are immutable');
END;
CREATE TRIGGER review_timer_observations_immutable_delete
BEFORE DELETE ON review_timer_observations BEGIN
  SELECT RAISE(ABORT, 'review timer observations cannot be deleted');
END;

CREATE INDEX review_timer_observations_timer
  ON review_timer_observations (workspace_id, timer_id, occurred_at ASC, observation_id ASC);

CREATE TABLE browser_activity_observations (
  workspace_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  human_id TEXT NOT NULL,
  task_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  capped INTEGER NOT NULL CHECK (capped IN (0, 1)),
  provenance TEXT NOT NULL CHECK (provenance IN ('human_observed')),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, observation_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (human_id) REFERENCES humans (id),
  CHECK (ended_at > started_at)
);
CREATE TRIGGER browser_activity_observations_immutable_update
BEFORE UPDATE ON browser_activity_observations BEGIN
  SELECT RAISE(ABORT, 'browser activity observations are immutable');
END;
CREATE TRIGGER browser_activity_observations_immutable_delete
BEFORE DELETE ON browser_activity_observations BEGIN
  SELECT RAISE(ABORT, 'browser activity observations cannot be deleted');
END;

CREATE INDEX browser_activity_observations_human
  ON browser_activity_observations (workspace_id, human_id, started_at ASC, observation_id ASC);

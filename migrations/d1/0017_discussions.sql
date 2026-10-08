-- ABOUTME: Stores bounded human-sponsored discussions with immutable briefs, rosters and attributed history.
-- ABOUTME: Separates discussion run purpose from ordinary work and correlates each turn with one durable delivery.

ALTER TABLE runs ADD COLUMN purpose TEXT NOT NULL DEFAULT 'work' CHECK (purpose IN ('work', 'discussion'));

CREATE TRIGGER runs_purpose_immutable
BEFORE UPDATE OF purpose ON runs
WHEN NEW.purpose != OLD.purpose
BEGIN
  SELECT RAISE(ABORT, 'run purpose is immutable');
END;

CREATE TRIGGER discussion_runs_no_work_result_insert
BEFORE INSERT ON runs
WHEN NEW.purpose = 'discussion' AND NEW.result_state NOT IN ('open', 'failed', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'discussion runs cannot submit or accept work');
END;

CREATE TRIGGER discussion_runs_no_work_result_update
BEFORE UPDATE OF result_state ON runs
WHEN NEW.purpose = 'discussion' AND NEW.result_state NOT IN ('open', 'failed', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'discussion runs cannot submit or accept work');
END;

CREATE TRIGGER discussion_runs_immutable_identity BEFORE UPDATE ON runs
WHEN OLD.purpose = 'discussion' AND (NEW.workspace_id != OLD.workspace_id OR NEW.id != OLD.id
  OR NEW.project_id != OLD.project_id OR NEW.task_id != OLD.task_id
  OR NEW.requested_by_human_id != OLD.requested_by_human_id OR NEW.agent_profile_id != OLD.agent_profile_id)
BEGIN SELECT RAISE(ABORT, 'discussion run identity is immutable'); END;

CREATE TABLE discussions (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  sponsor_human_id TEXT NOT NULL,
  sponsor_authorization_epoch INTEGER NOT NULL CHECK (sponsor_authorization_epoch >= 1),
  task_version INTEGER NOT NULL CHECK (task_version >= 1),
  brief_json TEXT NOT NULL CHECK (json_valid(brief_json) AND length(CAST(brief_json AS BLOB)) <= 65536),
  brief_hash TEXT NOT NULL CHECK (length(brief_hash) = 71 AND brief_hash GLOB 'sha256:[0-9a-f]*'),
  context_hash TEXT NOT NULL CHECK (length(context_hash) = 71 AND context_hash GLOB 'sha256:[0-9a-f]*'),
  git_revision TEXT NOT NULL CHECK (length(git_revision) IN (40, 64)),
  rounds INTEGER NOT NULL CHECK (rounds BETWEEN 1 AND 3),
  deadline TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'concluded', 'cancelled', 'failed')),
  reason TEXT CHECK (reason IN ('human_cancelled', 'deadline_exceeded', 'context_changed', 'sponsor_revoked', 'delivery_ambiguous', 'provider_failed')),
  resource_version INTEGER NOT NULL CHECK (resource_version >= 1),
  created_at TEXT NOT NULL,
  ended_at TEXT,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, id, task_id),
  CHECK ((state IN ('active', 'concluded') AND reason IS NULL) OR (state IN ('paused', 'cancelled', 'failed') AND reason IS NOT NULL)),
  CHECK ((state = 'active' AND ended_at IS NULL) OR (state != 'active' AND ended_at IS NOT NULL)),
  FOREIGN KEY (workspace_id, project_id, task_id) REFERENCES tasks (workspace_id, project_id, id),
  FOREIGN KEY (sponsor_human_id) REFERENCES humans (id)
);

CREATE INDEX discussions_task_index ON discussions (workspace_id, task_id, id);

CREATE TRIGGER discussions_immutable_brief
BEFORE UPDATE ON discussions
WHEN NEW.workspace_id != OLD.workspace_id OR NEW.id != OLD.id OR NEW.project_id != OLD.project_id
  OR NEW.task_id != OLD.task_id OR NEW.sponsor_human_id != OLD.sponsor_human_id
  OR NEW.sponsor_authorization_epoch != OLD.sponsor_authorization_epoch OR NEW.task_version != OLD.task_version
  OR NEW.brief_json != OLD.brief_json OR NEW.brief_hash != OLD.brief_hash OR NEW.context_hash != OLD.context_hash
  OR NEW.git_revision != OLD.git_revision OR NEW.rounds != OLD.rounds OR NEW.deadline != OLD.deadline
  OR NEW.created_at != OLD.created_at OR NEW.resource_version != OLD.resource_version + 1
  OR (OLD.state != 'active' AND NEW.state != OLD.state)
BEGIN
  SELECT RAISE(ABORT, 'discussion brief and terminal state are immutable');
END;

CREATE TABLE discussion_participants (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  discussion_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot IN (0, 1)),
  run_id TEXT NOT NULL,
  agent_profile_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  physical_worktree_hash TEXT NOT NULL CHECK (length(physical_worktree_hash) = 71),
  repository_config_hash TEXT NOT NULL CHECK (length(repository_config_hash) = 71),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, discussion_id, slot),
  UNIQUE (workspace_id, discussion_id, agent_profile_id),
  UNIQUE (workspace_id, run_id),
  UNIQUE (workspace_id, discussion_id, id),
  UNIQUE (workspace_id, discussion_id, id, run_id),
  FOREIGN KEY (workspace_id, discussion_id, task_id) REFERENCES discussions (workspace_id, id, task_id),
  FOREIGN KEY (workspace_id, run_id, task_id) REFERENCES runs (workspace_id, id, task_id),
  FOREIGN KEY (workspace_id, agent_profile_id) REFERENCES agent_profiles (workspace_id, id),
  FOREIGN KEY (workspace_id, snapshot_id) REFERENCES run_configuration_snapshots (workspace_id, id),
  FOREIGN KEY (workspace_id, runner_id) REFERENCES runners (workspace_id, id)
);

CREATE TRIGGER discussion_participants_run_binding
BEFORE INSERT ON discussion_participants
WHEN NOT EXISTS (
  SELECT 1 FROM runs AS run JOIN run_configuration_snapshots AS snapshot
    ON snapshot.workspace_id = run.workspace_id AND snapshot.run_id = run.id
  JOIN discussions AS discussion ON discussion.workspace_id = run.workspace_id AND discussion.id = NEW.discussion_id
  WHERE run.workspace_id = NEW.workspace_id AND run.id = NEW.run_id AND run.purpose = 'discussion'
    AND run.agent_profile_id = NEW.agent_profile_id AND snapshot.id = NEW.snapshot_id
    AND run.requested_by_human_id = discussion.sponsor_human_id
)
BEGIN
  SELECT RAISE(ABORT, 'discussion participant run binding is invalid');
END;

CREATE TRIGGER discussion_participants_immutable_update BEFORE UPDATE ON discussion_participants
BEGIN SELECT RAISE(ABORT, 'discussion roster is immutable'); END;
CREATE TRIGGER discussion_participants_immutable_delete BEFORE DELETE ON discussion_participants
BEGIN SELECT RAISE(ABORT, 'discussion roster is immutable'); END;

CREATE TABLE discussion_turns (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  discussion_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 6),
  state TEXT NOT NULL CHECK (state IN ('planned', 'active', 'completed', 'failed', 'cancelled')),
  resource_version INTEGER NOT NULL CHECK (resource_version >= 1),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, discussion_id, ordinal),
  UNIQUE (workspace_id, discussion_id, id),
  UNIQUE (workspace_id, discussion_id, id, participant_id),
  FOREIGN KEY (workspace_id, discussion_id, participant_id) REFERENCES discussion_participants (workspace_id, discussion_id, id)
);

CREATE TRIGGER discussion_turns_bounded_roster BEFORE INSERT ON discussion_turns
WHEN NOT EXISTS (
  SELECT 1 FROM discussions AS discussion JOIN discussion_participants AS participant
    ON participant.workspace_id = discussion.workspace_id AND participant.discussion_id = discussion.id
  WHERE discussion.workspace_id = NEW.workspace_id AND discussion.id = NEW.discussion_id
    AND participant.id = NEW.participant_id AND NEW.ordinal <= discussion.rounds * 2
    AND participant.slot = (NEW.ordinal - 1) % 2
)
BEGIN SELECT RAISE(ABORT, 'discussion turn exceeds its frozen roster or bound'); END;

CREATE TRIGGER discussion_turns_immutable_identity BEFORE UPDATE ON discussion_turns
WHEN NEW.workspace_id != OLD.workspace_id OR NEW.id != OLD.id OR NEW.discussion_id != OLD.discussion_id
  OR NEW.participant_id != OLD.participant_id OR NEW.ordinal != OLD.ordinal
  OR NEW.resource_version != OLD.resource_version + 1
  OR NOT ((OLD.state = 'planned' AND NEW.state IN ('active', 'failed', 'cancelled'))
    OR (OLD.state = 'active' AND NEW.state IN ('completed', 'failed', 'cancelled')))
BEGIN SELECT RAISE(ABORT, 'discussion turn transition is invalid'); END;

CREATE UNIQUE INDEX provider_sessions_run_identity ON provider_sessions (workspace_id, run_id, id);

CREATE TABLE discussion_session_bindings (
  workspace_id TEXT NOT NULL,
  discussion_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  observed_session_id TEXT NOT NULL CHECK (length(observed_session_id) BETWEEN 1 AND 256),
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, participant_id),
  UNIQUE (workspace_id, session_id),
  UNIQUE (workspace_id, runner_id, provider, observed_session_id),
  FOREIGN KEY (workspace_id, discussion_id, participant_id, run_id) REFERENCES discussion_participants (workspace_id, discussion_id, id, run_id),
  FOREIGN KEY (workspace_id, runner_id) REFERENCES runners (workspace_id, id),
  FOREIGN KEY (workspace_id, run_id, session_id) REFERENCES provider_sessions (workspace_id, run_id, id)
);

CREATE TRIGGER discussion_session_bindings_immutable_update BEFORE UPDATE ON discussion_session_bindings
BEGIN SELECT RAISE(ABORT, 'discussion session bindings are immutable'); END;
CREATE TRIGGER discussion_session_bindings_immutable_delete BEFORE DELETE ON discussion_session_bindings
BEGIN SELECT RAISE(ABORT, 'discussion session bindings are immutable'); END;

CREATE TABLE discussion_deliveries (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  discussion_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  source_message_ids_json TEXT NOT NULL CHECK (json_valid(source_message_ids_json) AND length(source_message_ids_json) <= 1024),
  state TEXT NOT NULL CHECK (state IN ('accepted', 'dispatched', 'acknowledged', 'completed', 'ambiguous', 'failed')),
  session_id TEXT,
  resource_version INTEGER NOT NULL CHECK (resource_version >= 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, turn_id),
  CHECK (state NOT IN ('acknowledged', 'completed') OR session_id IS NOT NULL),
  FOREIGN KEY (workspace_id, discussion_id, turn_id, participant_id) REFERENCES discussion_turns (workspace_id, discussion_id, id, participant_id),
  FOREIGN KEY (workspace_id, discussion_id, participant_id, run_id) REFERENCES discussion_participants (workspace_id, discussion_id, id, run_id),
  FOREIGN KEY (workspace_id, run_id, session_id) REFERENCES provider_sessions (workspace_id, run_id, id)
);

CREATE TRIGGER discussion_deliveries_frozen_input BEFORE UPDATE ON discussion_deliveries
WHEN NEW.workspace_id != OLD.workspace_id OR NEW.id != OLD.id OR NEW.discussion_id != OLD.discussion_id
  OR NEW.turn_id != OLD.turn_id OR NEW.participant_id != OLD.participant_id OR NEW.run_id != OLD.run_id
  OR NEW.source_message_ids_json != OLD.source_message_ids_json OR NEW.created_at != OLD.created_at
  OR NEW.resource_version != OLD.resource_version + 1
  OR (OLD.session_id IS NOT NULL AND NEW.session_id IS NOT OLD.session_id)
  OR NOT ((OLD.state = 'accepted' AND NEW.state IN ('dispatched', 'failed'))
    OR (OLD.state = 'dispatched' AND NEW.state IN ('acknowledged', 'ambiguous', 'failed'))
    OR (OLD.state = 'acknowledged' AND NEW.state IN ('completed', 'ambiguous', 'failed')))
BEGIN SELECT RAISE(ABORT, 'discussion delivery transition is invalid'); END;

CREATE TABLE discussion_messages (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  discussion_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('intervention', 'recommendation')),
  author_human_id TEXT,
  participant_id TEXT,
  run_id TEXT,
  session_id TEXT,
  turn_id TEXT,
  body_json TEXT NOT NULL CHECK (json_valid(body_json) AND length(CAST(body_json AS BLOB)) <= 8192),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, turn_id),
  CHECK ((kind = 'intervention' AND author_human_id IS NOT NULL AND participant_id IS NULL AND run_id IS NULL AND session_id IS NULL AND turn_id IS NULL)
    OR (kind = 'recommendation' AND author_human_id IS NULL AND participant_id IS NOT NULL AND run_id IS NOT NULL AND session_id IS NOT NULL AND turn_id IS NOT NULL)),
  FOREIGN KEY (workspace_id, discussion_id) REFERENCES discussions (workspace_id, id),
  FOREIGN KEY (author_human_id) REFERENCES humans (id),
  FOREIGN KEY (workspace_id, discussion_id, participant_id, run_id) REFERENCES discussion_participants (workspace_id, discussion_id, id, run_id),
  FOREIGN KEY (workspace_id, discussion_id, turn_id, participant_id) REFERENCES discussion_turns (workspace_id, discussion_id, id, participant_id),
  FOREIGN KEY (workspace_id, run_id, session_id) REFERENCES provider_sessions (workspace_id, run_id, id)
);

CREATE TRIGGER discussion_messages_immutable_update BEFORE UPDATE ON discussion_messages
BEGIN SELECT RAISE(ABORT, 'discussion messages are immutable'); END;
CREATE TRIGGER discussion_messages_immutable_delete BEFORE DELETE ON discussion_messages
BEGIN SELECT RAISE(ABORT, 'discussion messages are immutable'); END;

CREATE TABLE discussion_conclusions (
  workspace_id TEXT NOT NULL,
  discussion_id TEXT NOT NULL,
  recommendation_ids_json TEXT NOT NULL CHECK (json_valid(recommendation_ids_json) AND json_array_length(recommendation_ids_json) = 2),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, discussion_id),
  FOREIGN KEY (workspace_id, discussion_id) REFERENCES discussions (workspace_id, id)
);

CREATE TRIGGER discussion_conclusions_immutable_update BEFORE UPDATE ON discussion_conclusions
BEGIN SELECT RAISE(ABORT, 'discussion conclusions are immutable'); END;
CREATE TRIGGER discussion_conclusions_immutable_delete BEFORE DELETE ON discussion_conclusions
BEGIN SELECT RAISE(ABORT, 'discussion conclusions are immutable'); END;

CREATE TABLE discussion_decisions (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  discussion_id TEXT NOT NULL,
  human_id TEXT NOT NULL,
  authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch >= 1),
  body_json TEXT NOT NULL CHECK (json_valid(body_json) AND length(CAST(body_json AS BLOB)) <= 8192),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, discussion_id),
  FOREIGN KEY (workspace_id, discussion_id) REFERENCES discussions (workspace_id, id),
  FOREIGN KEY (human_id) REFERENCES humans (id)
);

CREATE TRIGGER discussion_decisions_immutable_update BEFORE UPDATE ON discussion_decisions
BEGIN SELECT RAISE(ABORT, 'discussion decisions are immutable'); END;
CREATE TRIGGER discussion_decisions_immutable_delete BEFORE DELETE ON discussion_decisions
BEGIN SELECT RAISE(ABORT, 'discussion decisions are immutable'); END;

CREATE TABLE discussion_command_receipts (
  workspace_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'run')),
  actor_id TEXT NOT NULL,
  authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch >= 1),
  command_name TEXT NOT NULL,
  key_hash TEXT NOT NULL CHECK (length(key_hash) = 71),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 71),
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND length(result_json) <= 4096),
  PRIMARY KEY (workspace_id, actor_type, actor_id, command_name, key_hash),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TRIGGER discussion_receipts_immutable_update BEFORE UPDATE ON discussion_command_receipts
BEGIN SELECT RAISE(ABORT, 'discussion command receipts are immutable'); END;
CREATE TRIGGER discussion_receipts_immutable_delete BEFORE DELETE ON discussion_command_receipts
BEGIN SELECT RAISE(ABORT, 'discussion command receipts are immutable'); END;

CREATE TRIGGER discussions_immutable_delete BEFORE DELETE ON discussions
BEGIN SELECT RAISE(ABORT, 'discussion briefs are immutable'); END;
CREATE TRIGGER discussion_turns_immutable_delete BEFORE DELETE ON discussion_turns
BEGIN SELECT RAISE(ABORT, 'discussion turns are immutable'); END;
CREATE TRIGGER discussion_deliveries_immutable_delete BEFORE DELETE ON discussion_deliveries
BEGIN SELECT RAISE(ABORT, 'discussion deliveries are immutable'); END;

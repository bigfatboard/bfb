-- ABOUTME: Binds immutable execution assignments to canonical sessions and attributable agent-work effects.
-- ABOUTME: Additive tenant foreign keys preserve creator history and permit one conversation across resumed executions.

CREATE UNIQUE INDEX execution_assignments_work_identity
ON execution_assignments (workspace_id, execution_id, assignment_generation, run_id, task_id, project_id, runner_id);
CREATE UNIQUE INDEX provider_sessions_observed_identity
ON provider_sessions (workspace_id, run_id, id, provider, observed_session_id);
CREATE UNIQUE INDEX comments_task_identity ON comments (workspace_id, id, task_id);

CREATE TABLE execution_session_bindings (
  workspace_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  assignment_generation INTEGER NOT NULL CHECK (assignment_generation >= 1),
  run_id TEXT NOT NULL,
  source_task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  provider_session_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'grok', 'fake')),
  observed_session_id TEXT NOT NULL CHECK (length(observed_session_id) BETWEEN 1 AND 128),
  observed_at TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, execution_id, assignment_generation),
  UNIQUE (workspace_id, execution_id, assignment_generation, run_id, provider_session_id, project_id, source_task_id),
  FOREIGN KEY (workspace_id, execution_id, assignment_generation, run_id, source_task_id, project_id, runner_id)
    REFERENCES execution_assignments (workspace_id, execution_id, assignment_generation, run_id, task_id, project_id, runner_id),
  FOREIGN KEY (workspace_id, run_id, provider_session_id, provider, observed_session_id)
    REFERENCES provider_sessions (workspace_id, run_id, id, provider, observed_session_id)
);
CREATE TRIGGER execution_session_bindings_immutable_update BEFORE UPDATE ON execution_session_bindings BEGIN
  SELECT RAISE(ABORT, 'execution session bindings are immutable');
END;
CREATE TRIGGER execution_session_bindings_immutable_delete BEFORE DELETE ON execution_session_bindings BEGIN
  SELECT RAISE(ABORT, 'execution session bindings are immutable');
END;

CREATE TABLE agent_work_effects (
  workspace_id TEXT NOT NULL,
  operation_key TEXT NOT NULL CHECK (length(operation_key) = 70 AND substr(operation_key, 1, 6) = 'agent:' AND substr(operation_key, 7) NOT GLOB '*[^0-9a-f]*'),
  kind TEXT NOT NULL CHECK (kind IN ('task.update', 'comment.add', 'progress.report', 'task.propose')),
  run_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  assignment_generation INTEGER NOT NULL CHECK (assignment_generation >= 1),
  provider_session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  source_task_id TEXT NOT NULL,
  target_task_id TEXT NOT NULL,
  comment_id TEXT,
  resulting_task_version INTEGER CHECK (resulting_task_version IS NULL OR resulting_task_version >= 1),
  percent REAL CHECK (percent IS NULL OR percent BETWEEN 0 AND 100),
  confidence REAL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, operation_key),
  CHECK (
    (kind IN ('comment.add', 'progress.report') AND comment_id IS NOT NULL AND resulting_task_version IS NULL)
    OR (kind IN ('task.update', 'task.propose') AND comment_id IS NULL AND resulting_task_version IS NOT NULL)
  ),
  CHECK (kind = 'progress.report' OR (percent IS NULL AND confidence IS NULL)),
  CHECK (kind = 'task.propose' OR source_task_id = target_task_id),
  FOREIGN KEY (workspace_id, execution_id, assignment_generation, run_id, provider_session_id, project_id, source_task_id)
    REFERENCES execution_session_bindings (workspace_id, execution_id, assignment_generation, run_id, provider_session_id, project_id, source_task_id),
  FOREIGN KEY (workspace_id, project_id, target_task_id) REFERENCES tasks (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, comment_id, target_task_id) REFERENCES comments (workspace_id, id, task_id)
);
CREATE UNIQUE INDEX agent_work_comment_origin ON agent_work_effects (workspace_id, comment_id) WHERE comment_id IS NOT NULL;
CREATE UNIQUE INDEX agent_work_proposal_origin ON agent_work_effects (workspace_id, target_task_id) WHERE kind = 'task.propose';
CREATE UNIQUE INDEX agent_work_task_revision ON agent_work_effects (workspace_id, target_task_id, resulting_task_version) WHERE resulting_task_version IS NOT NULL;
CREATE TRIGGER agent_work_effects_author_check BEFORE INSERT ON agent_work_effects
WHEN NEW.kind IN ('comment.add', 'progress.report') AND NOT EXISTS (
  SELECT 1 FROM comments WHERE workspace_id = NEW.workspace_id AND id = NEW.comment_id
    AND task_id = NEW.target_task_id AND author_human_id IS NULL AND author_delegation_id IS NULL
    AND kind = CASE NEW.kind WHEN 'comment.add' THEN 'discussion' ELSE 'progress' END
) BEGIN
  SELECT RAISE(ABORT, 'agent comment provenance requires an unattributed matching comment');
END;
CREATE TRIGGER agent_work_effects_immutable_update BEFORE UPDATE ON agent_work_effects BEGIN
  SELECT RAISE(ABORT, 'agent work effects are immutable');
END;
CREATE TRIGGER agent_work_effects_immutable_delete BEFORE DELETE ON agent_work_effects BEGIN
  SELECT RAISE(ABORT, 'agent work effects are immutable');
END;
CREATE TRIGGER agent_comment_author_immutable BEFORE UPDATE OF author_human_id, author_delegation_id, kind ON comments
WHEN EXISTS (
  SELECT 1 FROM agent_work_effects effect WHERE effect.workspace_id = OLD.workspace_id AND effect.comment_id = OLD.id
    AND (NEW.author_human_id IS NOT NULL OR NEW.author_delegation_id IS NOT NULL
      OR NEW.kind <> CASE effect.kind WHEN 'comment.add' THEN 'discussion' ELSE 'progress' END)
) BEGIN
  SELECT RAISE(ABORT, 'agent comment author and kind must match immutable provenance');
END;

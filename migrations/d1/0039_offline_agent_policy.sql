-- ABOUTME: Adds explicit deny-by-default offline agent-work permission to policy heads and history.
-- ABOUTME: Preserves existing canonical documents, launch snapshots and immutable version hashes.

ALTER TABLE workspace_policies
  ADD COLUMN offline_agent_tools_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(offline_agent_tools_json) AND json_type(offline_agent_tools_json) = 'array');
ALTER TABLE workspace_policies
  ADD COLUMN offline_agent_max_pending_age_seconds INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(offline_agent_max_pending_age_seconds) = 'integer' AND (
    (json_array_length(offline_agent_tools_json) = 0 AND offline_agent_max_pending_age_seconds = 0) OR
    (json_array_length(offline_agent_tools_json) BETWEEN 1 AND 4 AND offline_agent_max_pending_age_seconds BETWEEN 1 AND 300)
  ));

ALTER TABLE workspace_policy_versions
  ADD COLUMN offline_agent_tools_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(offline_agent_tools_json) AND json_type(offline_agent_tools_json) = 'array');
ALTER TABLE workspace_policy_versions
  ADD COLUMN offline_agent_max_pending_age_seconds INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(offline_agent_max_pending_age_seconds) = 'integer' AND (
    (json_array_length(offline_agent_tools_json) = 0 AND offline_agent_max_pending_age_seconds = 0) OR
    (json_array_length(offline_agent_tools_json) BETWEEN 1 AND 4 AND offline_agent_max_pending_age_seconds BETWEEN 1 AND 300)
  ));

ALTER TABLE project_policies
  ADD COLUMN offline_agent_tools_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(offline_agent_tools_json) AND json_type(offline_agent_tools_json) = 'array');
ALTER TABLE project_policies
  ADD COLUMN offline_agent_max_pending_age_seconds INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(offline_agent_max_pending_age_seconds) = 'integer' AND (
    (json_array_length(offline_agent_tools_json) = 0 AND offline_agent_max_pending_age_seconds = 0) OR
    (json_array_length(offline_agent_tools_json) BETWEEN 1 AND 4 AND offline_agent_max_pending_age_seconds BETWEEN 1 AND 300)
  ));

ALTER TABLE project_policy_versions
  ADD COLUMN offline_agent_tools_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(offline_agent_tools_json) AND json_type(offline_agent_tools_json) = 'array');
ALTER TABLE project_policy_versions
  ADD COLUMN offline_agent_max_pending_age_seconds INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(offline_agent_max_pending_age_seconds) = 'integer' AND (
    (json_array_length(offline_agent_tools_json) = 0 AND offline_agent_max_pending_age_seconds = 0) OR
    (json_array_length(offline_agent_tools_json) BETWEEN 1 AND 4 AND offline_agent_max_pending_age_seconds BETWEEN 1 AND 300)
  ));

ALTER TABLE repository_configs
  ADD COLUMN offline_agent_tools_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(offline_agent_tools_json) AND json_type(offline_agent_tools_json) = 'array');
ALTER TABLE repository_configs
  ADD COLUMN offline_agent_max_pending_age_seconds INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(offline_agent_max_pending_age_seconds) = 'integer' AND (
    (json_array_length(offline_agent_tools_json) = 0 AND offline_agent_max_pending_age_seconds = 0) OR
    (json_array_length(offline_agent_tools_json) BETWEEN 1 AND 4 AND offline_agent_max_pending_age_seconds BETWEEN 1 AND 300)
  ));

ALTER TABLE repository_config_versions
  ADD COLUMN offline_agent_tools_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(offline_agent_tools_json) AND json_type(offline_agent_tools_json) = 'array');
ALTER TABLE repository_config_versions
  ADD COLUMN offline_agent_max_pending_age_seconds INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(offline_agent_max_pending_age_seconds) = 'integer' AND (
    (json_array_length(offline_agent_tools_json) = 0 AND offline_agent_max_pending_age_seconds = 0) OR
    (json_array_length(offline_agent_tools_json) BETWEEN 1 AND 4 AND offline_agent_max_pending_age_seconds BETWEEN 1 AND 300)
  ));

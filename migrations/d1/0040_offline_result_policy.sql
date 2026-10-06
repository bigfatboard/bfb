-- ABOUTME: Adds independent deny-by-default offline result permission to policy heads and history.
-- ABOUTME: Retains existing repository documents, immutable versions and launch snapshot bytes.

ALTER TABLE workspace_policies
  ADD COLUMN offline_result_allow_submit INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(offline_result_allow_submit) = 'integer' AND offline_result_allow_submit IN (0, 1));
ALTER TABLE workspace_policies
  ADD COLUMN offline_result_max_pending_age_seconds INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(offline_result_max_pending_age_seconds) = 'integer' AND (
    (offline_result_allow_submit = 0 AND offline_result_max_pending_age_seconds = 0) OR
    (offline_result_allow_submit = 1 AND offline_result_max_pending_age_seconds BETWEEN 1 AND 300)
  ));

ALTER TABLE workspace_policy_versions
  ADD COLUMN offline_result_allow_submit INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(offline_result_allow_submit) = 'integer' AND offline_result_allow_submit IN (0, 1));
ALTER TABLE workspace_policy_versions
  ADD COLUMN offline_result_max_pending_age_seconds INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(offline_result_max_pending_age_seconds) = 'integer' AND (
    (offline_result_allow_submit = 0 AND offline_result_max_pending_age_seconds = 0) OR
    (offline_result_allow_submit = 1 AND offline_result_max_pending_age_seconds BETWEEN 1 AND 300)
  ));

ALTER TABLE project_policies
  ADD COLUMN offline_result_allow_submit INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(offline_result_allow_submit) = 'integer' AND offline_result_allow_submit IN (0, 1));
ALTER TABLE project_policies
  ADD COLUMN offline_result_max_pending_age_seconds INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(offline_result_max_pending_age_seconds) = 'integer' AND (
    (offline_result_allow_submit = 0 AND offline_result_max_pending_age_seconds = 0) OR
    (offline_result_allow_submit = 1 AND offline_result_max_pending_age_seconds BETWEEN 1 AND 300)
  ));

ALTER TABLE project_policy_versions
  ADD COLUMN offline_result_allow_submit INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(offline_result_allow_submit) = 'integer' AND offline_result_allow_submit IN (0, 1));
ALTER TABLE project_policy_versions
  ADD COLUMN offline_result_max_pending_age_seconds INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(offline_result_max_pending_age_seconds) = 'integer' AND (
    (offline_result_allow_submit = 0 AND offline_result_max_pending_age_seconds = 0) OR
    (offline_result_allow_submit = 1 AND offline_result_max_pending_age_seconds BETWEEN 1 AND 300)
  ));

ALTER TABLE repository_configs
  ADD COLUMN offline_result_allow_submit INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(offline_result_allow_submit) = 'integer' AND offline_result_allow_submit IN (0, 1));
ALTER TABLE repository_configs
  ADD COLUMN offline_result_max_pending_age_seconds INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(offline_result_max_pending_age_seconds) = 'integer' AND (
    (offline_result_allow_submit = 0 AND offline_result_max_pending_age_seconds = 0) OR
    (offline_result_allow_submit = 1 AND offline_result_max_pending_age_seconds BETWEEN 1 AND 300)
  ));

ALTER TABLE repository_config_versions
  ADD COLUMN offline_result_allow_submit INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(offline_result_allow_submit) = 'integer' AND offline_result_allow_submit IN (0, 1));
ALTER TABLE repository_config_versions
  ADD COLUMN offline_result_max_pending_age_seconds INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(offline_result_max_pending_age_seconds) = 'integer' AND (
    (offline_result_allow_submit = 0 AND offline_result_max_pending_age_seconds = 0) OR
    (offline_result_allow_submit = 1 AND offline_result_max_pending_age_seconds BETWEEN 1 AND 300)
  ));

-- ABOUTME: Adds explicit permission modes without changing existing profile harness restrictions.
-- ABOUTME: Historical profiles default to manual while immutable version triggers remain intact.

ALTER TABLE agent_profiles ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'manual'
  CHECK (permission_mode IN ('manual', 'autonomous') AND
    (permission_mode = 'manual' OR
      (provider = 'claude' AND execution_mode = 'interactive' AND harness_mode = 'standard')));

ALTER TABLE agent_profile_versions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'manual'
  CHECK (permission_mode IN ('manual', 'autonomous') AND
    (permission_mode = 'manual' OR
      (provider = 'claude' AND execution_mode = 'interactive' AND harness_mode = 'standard')));

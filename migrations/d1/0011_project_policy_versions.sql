-- ABOUTME: Adds canonical project identity, explicit access modes, and immutable policy/config versions.
-- ABOUTME: Current heads remain mutable only through versioned WorkspaceHub commands.

ALTER TABLE projects
  ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'restricted'
  CHECK (access_mode IN ('workspace', 'restricted'));
ALTER TABLE projects
  ADD COLUMN repository_host TEXT NOT NULL DEFAULT 'synthetic';
ALTER TABLE projects
  ADD COLUMN hosted_repository_id TEXT NOT NULL DEFAULT '';
ALTER TABLE projects
  ADD COLUMN repository_subpath TEXT NOT NULL DEFAULT '.';

UPDATE projects SET hosted_repository_id = id WHERE hosted_repository_id = '';

CREATE UNIQUE INDEX projects_repository_identity
ON projects (workspace_id, repository_host, hosted_repository_id, repository_subpath);

CREATE TRIGGER projects_repository_identity_insert
BEFORE INSERT ON projects
FOR EACH ROW
WHEN NEW.repository_host = ''
  OR (NEW.hosted_repository_id = '' AND NEW.repository_host != 'synthetic')
  OR NEW.repository_subpath = ''
  OR substr(NEW.repository_subpath, 1, 1) IN ('/', '~')
  OR instr(NEW.repository_subpath, '\\') > 0
  OR instr('/' || NEW.repository_subpath || '/', '/../') > 0
BEGIN
  SELECT RAISE(ABORT, 'project repository identity is invalid');
END;

CREATE TRIGGER projects_repository_identity_default
AFTER INSERT ON projects
FOR EACH ROW
WHEN NEW.repository_host = 'synthetic' AND NEW.hosted_repository_id = ''
BEGIN
  UPDATE projects SET hosted_repository_id = NEW.id
  WHERE workspace_id = NEW.workspace_id AND id = NEW.id;
END;

CREATE TRIGGER projects_repository_identity_immutable
BEFORE UPDATE OF repository_host, hosted_repository_id, repository_subpath ON projects
FOR EACH ROW
WHEN OLD.hosted_repository_id != ''
 AND (NEW.repository_host IS NOT OLD.repository_host
  OR NEW.hosted_repository_id IS NOT OLD.hosted_repository_id
  OR NEW.repository_subpath IS NOT OLD.repository_subpath)
BEGIN
  SELECT RAISE(ABORT, 'project repository identity is immutable');
END;

CREATE TRIGGER projects_access_mode_valid
BEFORE UPDATE OF access_mode ON projects
FOR EACH ROW
WHEN NEW.access_mode NOT IN ('workspace', 'restricted')
BEGIN
  SELECT RAISE(ABORT, 'project access mode is invalid');
END;

INSERT OR IGNORE INTO project_access (workspace_id, project_id, human_id)
SELECT projects.workspace_id, projects.id, members.human_id
FROM projects
JOIN workspace_members AS members
  ON members.workspace_id = projects.workspace_id
WHERE members.role IN ('owner', 'member');

CREATE TABLE workspace_policies (
  workspace_id TEXT NOT NULL,
  allowed_providers_json TEXT NOT NULL CHECK (json_valid(allowed_providers_json)),
  allow_agent_root_propose INTEGER NOT NULL CHECK (allow_agent_root_propose IN (0, 1)),
  allow_pass_to_agent INTEGER NOT NULL CHECK (allow_pass_to_agent IN (0, 1)),
  allow_run_overrides INTEGER NOT NULL CHECK (allow_run_overrides IN (0, 1)),
  resource_version INTEGER NOT NULL CHECK (resource_version >= 1),
  PRIMARY KEY (workspace_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE workspace_policy_versions (
  workspace_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  allowed_providers_json TEXT NOT NULL CHECK (json_valid(allowed_providers_json)),
  allow_agent_root_propose INTEGER NOT NULL CHECK (allow_agent_root_propose IN (0, 1)),
  allow_pass_to_agent INTEGER NOT NULL CHECK (allow_pass_to_agent IN (0, 1)),
  allow_run_overrides INTEGER NOT NULL CHECK (allow_run_overrides IN (0, 1)),
  created_by_human_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, version),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (created_by_human_id) REFERENCES humans (id)
);

INSERT INTO workspace_policies
  (workspace_id, allowed_providers_json, allow_agent_root_propose,
   allow_pass_to_agent, allow_run_overrides, resource_version)
SELECT id, '["claude","codex","grok"]', 1, 1, 1, 1 FROM workspaces;

INSERT INTO workspace_policy_versions
  (workspace_id, version, allowed_providers_json, allow_agent_root_propose,
   allow_pass_to_agent, allow_run_overrides, created_by_human_id, created_at)
SELECT id, 1, '["claude","codex","grok"]', 1, 1, 1, NULL, created_at FROM workspaces;

ALTER TABLE project_policies
  ADD COLUMN allowed_providers_json TEXT NOT NULL DEFAULT '["claude","codex","grok"]'
  CHECK (json_valid(allowed_providers_json));
ALTER TABLE project_policies
  ADD COLUMN allow_run_overrides INTEGER NOT NULL DEFAULT 1
  CHECK (allow_run_overrides IN (0, 1));

CREATE TABLE project_policy_versions (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  allowed_providers_json TEXT NOT NULL CHECK (json_valid(allowed_providers_json)),
  allow_agent_root_propose INTEGER NOT NULL CHECK (allow_agent_root_propose IN (0, 1)),
  allow_pass_to_agent INTEGER NOT NULL CHECK (allow_pass_to_agent IN (0, 1)),
  allow_run_overrides INTEGER NOT NULL CHECK (allow_run_overrides IN (0, 1)),
  created_by_human_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, project_id, version),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id),
  FOREIGN KEY (created_by_human_id) REFERENCES humans (id)
);

INSERT INTO project_policy_versions
  (workspace_id, project_id, version, allowed_providers_json,
   allow_agent_root_propose, allow_pass_to_agent, allow_run_overrides,
   created_by_human_id, created_at)
SELECT policies.workspace_id, policies.project_id, policies.resource_version,
       policies.allowed_providers_json, policies.allow_agent_root_propose,
       policies.allow_pass_to_agent, policies.allow_run_overrides,
       NULL, projects.created_at
FROM project_policies AS policies
JOIN projects
  ON projects.workspace_id = policies.workspace_id
 AND projects.id = policies.project_id;

CREATE TABLE repository_configs (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),
  content_hash TEXT NOT NULL,
  allowed_providers_json TEXT NOT NULL CHECK (json_valid(allowed_providers_json)),
  allow_agent_root_propose INTEGER NOT NULL CHECK (allow_agent_root_propose IN (0, 1)),
  allow_pass_to_agent INTEGER NOT NULL CHECK (allow_pass_to_agent IN (0, 1)),
  allow_run_overrides INTEGER NOT NULL CHECK (allow_run_overrides IN (0, 1)),
  resource_version INTEGER NOT NULL CHECK (resource_version >= 1),
  PRIMARY KEY (workspace_id, project_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id)
);

CREATE TABLE repository_config_versions (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),
  content_hash TEXT NOT NULL,
  allowed_providers_json TEXT NOT NULL CHECK (json_valid(allowed_providers_json)),
  allow_agent_root_propose INTEGER NOT NULL CHECK (allow_agent_root_propose IN (0, 1)),
  allow_pass_to_agent INTEGER NOT NULL CHECK (allow_pass_to_agent IN (0, 1)),
  allow_run_overrides INTEGER NOT NULL CHECK (allow_run_overrides IN (0, 1)),
  reported_by_human_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, project_id, version),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id),
  FOREIGN KEY (reported_by_human_id) REFERENCES humans (id)
);

INSERT INTO repository_configs
  (workspace_id, project_id, canonical_json, content_hash, allowed_providers_json,
   allow_agent_root_propose, allow_pass_to_agent, allow_run_overrides, resource_version)
SELECT workspace_id, id, '{}',
       'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
       '["claude","codex","grok"]', 1, 1, 1, 1
FROM projects;

INSERT INTO repository_config_versions
  (workspace_id, project_id, version, canonical_json, content_hash,
   allowed_providers_json, allow_agent_root_propose, allow_pass_to_agent,
   allow_run_overrides, reported_by_human_id, created_at)
SELECT workspace_id, id, 1, '{}',
       'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
       '["claude","codex","grok"]', 1, 1, 1, NULL, created_at
FROM projects;

CREATE TRIGGER workspaces_default_policy
AFTER INSERT ON workspaces
FOR EACH ROW
BEGIN
  INSERT INTO workspace_policies
    (workspace_id, allowed_providers_json, allow_agent_root_propose,
     allow_pass_to_agent, allow_run_overrides, resource_version)
  VALUES (NEW.id, '["claude","codex","grok"]', 1, 1, 1, 1);
  INSERT INTO workspace_policy_versions
    (workspace_id, version, allowed_providers_json, allow_agent_root_propose,
     allow_pass_to_agent, allow_run_overrides, created_by_human_id, created_at)
  VALUES (NEW.id, 1, '["claude","codex","grok"]', 1, 1, 1, NULL, NEW.created_at);
END;

CREATE TRIGGER projects_default_policy_and_config
AFTER INSERT ON projects
FOR EACH ROW
BEGIN
  INSERT INTO project_policies
    (workspace_id, project_id, allow_agent_root_propose, allow_pass_to_agent,
     resource_version, allowed_providers_json, allow_run_overrides)
  SELECT NEW.workspace_id, NEW.id, allow_agent_root_propose, allow_pass_to_agent,
         1, allowed_providers_json, allow_run_overrides
  FROM workspace_policies WHERE workspace_id = NEW.workspace_id;
  INSERT INTO project_policy_versions
    (workspace_id, project_id, version, allowed_providers_json,
     allow_agent_root_propose, allow_pass_to_agent, allow_run_overrides,
     created_by_human_id, created_at)
  SELECT NEW.workspace_id, NEW.id, 1, allowed_providers_json,
         allow_agent_root_propose, allow_pass_to_agent, allow_run_overrides,
         NULL, NEW.created_at
  FROM workspace_policies WHERE workspace_id = NEW.workspace_id;
  INSERT INTO repository_configs
    (workspace_id, project_id, canonical_json, content_hash, allowed_providers_json,
     allow_agent_root_propose, allow_pass_to_agent, allow_run_overrides, resource_version)
  SELECT NEW.workspace_id, NEW.id, '{}',
         'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
         allowed_providers_json, allow_agent_root_propose, allow_pass_to_agent,
         allow_run_overrides, 1
  FROM workspace_policies WHERE workspace_id = NEW.workspace_id;
  INSERT INTO repository_config_versions
    (workspace_id, project_id, version, canonical_json, content_hash,
     allowed_providers_json, allow_agent_root_propose, allow_pass_to_agent,
     allow_run_overrides, reported_by_human_id, created_at)
  SELECT NEW.workspace_id, NEW.id, 1, '{}',
         'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
         allowed_providers_json, allow_agent_root_propose, allow_pass_to_agent,
         allow_run_overrides, NULL, NEW.created_at
  FROM workspace_policies WHERE workspace_id = NEW.workspace_id;
END;

ALTER TABLE agent_profiles ADD COLUMN model TEXT;
ALTER TABLE agent_profiles
  ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'interactive'
  CHECK (execution_mode IN ('interactive', 'headless'));
ALTER TABLE agent_profiles
  ADD COLUMN harness_mode TEXT NOT NULL DEFAULT 'standard'
  CHECK (harness_mode IN ('restricted', 'standard'));
ALTER TABLE agent_profiles
  ADD COLUMN resource_version INTEGER NOT NULL DEFAULT 1
  CHECK (resource_version >= 1);

CREATE UNIQUE INDEX agent_profiles_name_unique ON agent_profiles (workspace_id, name);

CREATE TABLE agent_profile_versions (
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'grok')),
  model TEXT,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('interactive', 'headless')),
  harness_mode TEXT NOT NULL CHECK (harness_mode IN ('restricted', 'standard')),
  created_by_human_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, profile_id, version),
  FOREIGN KEY (workspace_id, profile_id) REFERENCES agent_profiles (workspace_id, id),
  FOREIGN KEY (created_by_human_id) REFERENCES humans (id)
);

INSERT INTO agent_profile_versions
  (workspace_id, profile_id, version, name, provider, model,
   execution_mode, harness_mode, created_by_human_id, created_at)
SELECT profiles.workspace_id, profiles.id, 1, profiles.name, profiles.provider, NULL,
       'interactive', 'standard', NULL, workspaces.created_at
FROM agent_profiles AS profiles
JOIN workspaces ON workspaces.id = profiles.workspace_id;

CREATE TRIGGER workspace_policy_versions_immutable_update
BEFORE UPDATE ON workspace_policy_versions BEGIN
  SELECT RAISE(ABORT, 'workspace policy versions are immutable');
END;
CREATE TRIGGER workspace_policy_versions_immutable_delete
BEFORE DELETE ON workspace_policy_versions BEGIN
  SELECT RAISE(ABORT, 'workspace policy versions are immutable');
END;
CREATE TRIGGER project_policy_versions_immutable_update
BEFORE UPDATE ON project_policy_versions BEGIN
  SELECT RAISE(ABORT, 'project policy versions are immutable');
END;
CREATE TRIGGER project_policy_versions_immutable_delete
BEFORE DELETE ON project_policy_versions BEGIN
  SELECT RAISE(ABORT, 'project policy versions are immutable');
END;
CREATE TRIGGER repository_config_versions_immutable_update
BEFORE UPDATE ON repository_config_versions BEGIN
  SELECT RAISE(ABORT, 'repository config versions are immutable');
END;
CREATE TRIGGER repository_config_versions_immutable_delete
BEFORE DELETE ON repository_config_versions BEGIN
  SELECT RAISE(ABORT, 'repository config versions are immutable');
END;
CREATE TRIGGER agent_profile_versions_immutable_update
BEFORE UPDATE ON agent_profile_versions BEGIN
  SELECT RAISE(ABORT, 'agent profile versions are immutable');
END;
CREATE TRIGGER agent_profile_versions_immutable_delete
BEFORE DELETE ON agent_profile_versions BEGIN
  SELECT RAISE(ABORT, 'agent profile versions are immutable');
END;

CREATE TRIGGER agent_profiles_identity_immutable
BEFORE UPDATE OF id ON agent_profiles
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT, 'agent profile id is immutable');
END;

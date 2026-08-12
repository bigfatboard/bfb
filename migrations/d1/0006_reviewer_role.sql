-- ABOUTME: Renames restricted_member workspace role to reviewer per C04 roles model.
-- ABOUTME: Project grants remain orthogonal to roles via project_access.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE workspace_members_new (
  workspace_id TEXT NOT NULL,
  human_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'reviewer')),
  authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch >= 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, human_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (human_id) REFERENCES humans (id)
);

INSERT INTO workspace_members_new (workspace_id, human_id, role, authorization_epoch, created_at)
SELECT
  workspace_id,
  human_id,
  CASE role WHEN 'restricted_member' THEN 'reviewer' ELSE role END,
  authorization_epoch,
  created_at
FROM workspace_members;

CREATE TABLE project_access_new (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  human_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, project_id, human_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id),
  FOREIGN KEY (workspace_id, human_id)
    REFERENCES workspace_members_new (workspace_id, human_id)
);

INSERT INTO project_access_new (workspace_id, project_id, human_id)
SELECT workspace_id, project_id, human_id
FROM project_access;

DROP TABLE project_access;
DROP TABLE workspace_members;
ALTER TABLE workspace_members_new RENAME TO workspace_members;
ALTER TABLE project_access_new RENAME TO project_access;

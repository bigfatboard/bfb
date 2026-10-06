-- ABOUTME: Adds dormant creator-private task policies and epoch-bound named-human grants.
-- ABOUTME: Retains policy/grant authority so deletion or rebinding cannot reopen private work.

CREATE TABLE task_privacy (
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  owner_human_id TEXT NOT NULL,
  access_version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(access_version) = 'integer' AND access_version >= 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, task_id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, owner_human_id)
    REFERENCES workspace_authorization_epochs (workspace_id, human_id) ON DELETE RESTRICT
);

CREATE TRIGGER task_privacy_creator_binding BEFORE INSERT ON task_privacy
WHEN NOT EXISTS (
  SELECT 1 FROM tasks WHERE workspace_id = NEW.workspace_id AND id = NEW.task_id
    AND created_by_human_id = NEW.owner_human_id
)
BEGIN SELECT RAISE(ABORT, 'private task creator mismatch'); END;

CREATE TRIGGER task_privacy_identity_immutable BEFORE UPDATE ON task_privacy
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.task_id IS NOT OLD.task_id
  OR NEW.owner_human_id IS NOT OLD.owner_human_id OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'private task identity is immutable'); END;

CREATE TRIGGER task_privacy_retained BEFORE DELETE ON task_privacy
BEGIN SELECT RAISE(ABORT, 'private task policy is retained'); END;

CREATE TRIGGER private_task_creator_immutable BEFORE UPDATE OF created_by_human_id ON tasks
WHEN NEW.created_by_human_id IS NOT OLD.created_by_human_id AND EXISTS (
  SELECT 1 FROM task_privacy WHERE workspace_id = OLD.workspace_id AND task_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'private task creator is immutable'); END;

CREATE TABLE task_human_grants (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  human_id TEXT NOT NULL,
  authorization_epoch INTEGER NOT NULL CHECK (typeof(authorization_epoch) = 'integer' AND authorization_epoch >= 1),
  permission TEXT NOT NULL CHECK (permission IN ('read', 'contribute', 'edit')),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES task_privacy (workspace_id, task_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, human_id)
    REFERENCES workspace_authorization_epochs (workspace_id, human_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX task_human_grant_active
  ON task_human_grants (workspace_id, task_id, human_id, authorization_epoch)
  WHERE revoked_at IS NULL;

CREATE TRIGGER task_human_grant_current_epoch BEFORE INSERT ON task_human_grants
WHEN NOT EXISTS (
  SELECT 1 FROM workspace_members AS member
  JOIN workspace_authorization_epochs AS epoch
    ON epoch.workspace_id = member.workspace_id AND epoch.human_id = member.human_id
   AND epoch.authorization_epoch = member.authorization_epoch AND epoch.revoked_at IS NULL
  WHERE member.workspace_id = NEW.workspace_id AND member.human_id = NEW.human_id
    AND epoch.authorization_epoch = NEW.authorization_epoch
)
BEGIN SELECT RAISE(ABORT, 'task grant epoch mismatch'); END;

CREATE TRIGGER task_human_grant_identity_immutable BEFORE UPDATE ON task_human_grants
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.id IS NOT OLD.id
  OR NEW.task_id IS NOT OLD.task_id OR NEW.human_id IS NOT OLD.human_id
  OR NEW.authorization_epoch IS NOT OLD.authorization_epoch
  OR NEW.permission IS NOT OLD.permission OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'task grant authority is immutable'); END;

CREATE TRIGGER task_human_grant_revocation_retained BEFORE UPDATE OF revoked_at ON task_human_grants
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at
BEGIN SELECT RAISE(ABORT, 'task grant revocation is retained'); END;

CREATE TRIGGER task_human_grant_retained BEFORE DELETE ON task_human_grants
BEGIN SELECT RAISE(ABORT, 'task grant is retained'); END;

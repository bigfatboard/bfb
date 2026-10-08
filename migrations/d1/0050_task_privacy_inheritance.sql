-- ABOUTME: Retains same-project private-root associations without changing descendant authorship.
-- ABOUTME: Enforces immediate-parent inheritance and preserves associated task creation lineage.

CREATE TABLE task_privacy_inheritance (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  root_task_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, task_id),
  CHECK (task_id != root_task_id),
  FOREIGN KEY (workspace_id, project_id, task_id)
    REFERENCES tasks (workspace_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, project_id, root_task_id)
    REFERENCES tasks (workspace_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, root_task_id)
    REFERENCES task_privacy (workspace_id, task_id) ON DELETE RESTRICT
);

CREATE INDEX task_privacy_inheritance_root
  ON task_privacy_inheritance (workspace_id, root_task_id, task_id);

CREATE TRIGGER task_privacy_inheritance_insert_collision
BEFORE INSERT ON task_privacy_inheritance
WHEN EXISTS (
  SELECT 1 FROM task_privacy_inheritance
  WHERE workspace_id = NEW.workspace_id AND task_id = NEW.task_id
)
BEGIN SELECT RAISE(ABORT, 'private task inheritance cannot be replaced'); END;

CREATE TRIGGER task_privacy_inheritance_parent_binding
BEFORE INSERT ON task_privacy_inheritance
WHEN EXISTS (
  SELECT 1 FROM task_privacy
  WHERE workspace_id = NEW.workspace_id AND task_id = NEW.task_id
) OR NOT EXISTS (
  SELECT 1 FROM tasks AS child
  WHERE child.workspace_id = NEW.workspace_id
    AND child.project_id = NEW.project_id AND child.id = NEW.task_id
    AND (
      child.parent_task_id = NEW.root_task_id
      OR EXISTS (
        SELECT 1 FROM task_privacy_inheritance AS parent
        WHERE parent.workspace_id = child.workspace_id
          AND parent.project_id = child.project_id
          AND parent.task_id = child.parent_task_id
          AND parent.root_task_id = NEW.root_task_id
      )
    )
)
BEGIN SELECT RAISE(ABORT, 'private task inheritance parent mismatch'); END;

CREATE TRIGGER task_privacy_inheritance_immutable
BEFORE UPDATE ON task_privacy_inheritance
BEGIN SELECT RAISE(ABORT, 'private task inheritance is immutable'); END;

CREATE TRIGGER task_privacy_inheritance_retained
BEFORE DELETE ON task_privacy_inheritance
BEGIN SELECT RAISE(ABORT, 'private task inheritance is retained'); END;

CREATE TRIGGER task_privacy_inheritance_no_direct_policy
BEFORE INSERT ON task_privacy
WHEN EXISTS (
  SELECT 1 FROM task_privacy_inheritance
  WHERE workspace_id = NEW.workspace_id AND task_id = NEW.task_id
)
BEGIN SELECT RAISE(ABORT, 'inherited private task cannot have a direct policy'); END;

CREATE TRIGGER inherited_private_task_lineage_immutable
BEFORE UPDATE OF workspace_id, id, project_id, parent_task_id,
  created_by_human_id, created_by_delegation_id, created_at ON tasks
WHEN EXISTS (
  SELECT 1 FROM task_privacy_inheritance
  WHERE workspace_id = OLD.workspace_id AND task_id = OLD.id
) AND (
  NEW.workspace_id IS NOT OLD.workspace_id OR NEW.id IS NOT OLD.id
  OR NEW.project_id IS NOT OLD.project_id OR NEW.parent_task_id IS NOT OLD.parent_task_id
  OR NEW.created_by_human_id IS NOT OLD.created_by_human_id
  OR NEW.created_by_delegation_id IS NOT OLD.created_by_delegation_id
  OR NEW.created_at IS NOT OLD.created_at
)
BEGIN SELECT RAISE(ABORT, 'inherited private task lineage is immutable'); END;

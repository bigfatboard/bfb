-- ABOUTME: Hardens F04 tenant invariants: immutable workspace jurisdiction and registry identity.
-- ABOUTME: Validates prior registry rows before later tenant relationship migrations run.

DROP TABLE IF EXISTS schema_migrations;

CREATE TRIGGER IF NOT EXISTS workspaces_jurisdiction_immutable
BEFORE UPDATE OF jurisdiction ON workspaces
FOR EACH ROW
WHEN NEW.jurisdiction IS NOT OLD.jurisdiction
BEGIN
  SELECT RAISE(ABORT, 'workspace jurisdiction is immutable');
END;

CREATE TRIGGER IF NOT EXISTS workspaces_jurisdiction_delete_forbidden
BEFORE DELETE ON workspaces
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'workspace registry rows cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS workspaces_ulid_insert
BEFORE INSERT ON workspaces
FOR EACH ROW
WHEN length(NEW.id) != 26
  OR substr(NEW.id, 1, 1) NOT GLOB '[0-7]'
  OR NEW.id GLOB '*[^0-9A-HJKMNP-TV-Z]*'
BEGIN
  SELECT RAISE(ABORT, 'workspace id must be a ULID');
END;

CREATE TRIGGER IF NOT EXISTS workspaces_identity_immutable
BEFORE UPDATE OF id ON workspaces
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT, 'workspace id is immutable');
END;

CREATE TRIGGER IF NOT EXISTS workspaces_ulid_update
BEFORE UPDATE OF id ON workspaces
FOR EACH ROW
WHEN length(NEW.id) != 26
  OR substr(NEW.id, 1, 1) NOT GLOB '[0-7]'
  OR NEW.id GLOB '*[^0-9A-HJKMNP-TV-Z]*'
BEGIN
  SELECT RAISE(ABORT, 'workspace id must be a ULID');
END;

CREATE TRIGGER IF NOT EXISTS tenant_fixture_items_ulid_insert
BEFORE INSERT ON tenant_fixture_items
FOR EACH ROW
WHEN length(NEW.id) != 26
  OR substr(NEW.id, 1, 1) NOT GLOB '[0-7]'
  OR NEW.id GLOB '*[^0-9A-HJKMNP-TV-Z]*'
BEGIN
  SELECT RAISE(ABORT, 'fixture item id must be a ULID');
END;

CREATE TRIGGER IF NOT EXISTS tenant_fixture_items_ulid_update
BEFORE UPDATE OF id ON tenant_fixture_items
FOR EACH ROW
WHEN length(NEW.id) != 26
  OR substr(NEW.id, 1, 1) NOT GLOB '[0-7]'
  OR NEW.id GLOB '*[^0-9A-HJKMNP-TV-Z]*'
BEGIN
  SELECT RAISE(ABORT, 'fixture item id must be a ULID');
END;

CREATE TRIGGER IF NOT EXISTS tenant_fixture_children_ulid_insert
BEFORE INSERT ON tenant_fixture_children
FOR EACH ROW
WHEN length(NEW.id) != 26
  OR substr(NEW.id, 1, 1) NOT GLOB '[0-7]'
  OR NEW.id GLOB '*[^0-9A-HJKMNP-TV-Z]*'
BEGIN
  SELECT RAISE(ABORT, 'fixture child id must be a ULID');
END;

CREATE TRIGGER IF NOT EXISTS tenant_fixture_children_ulid_update
BEFORE UPDATE OF id ON tenant_fixture_children
FOR EACH ROW
WHEN length(NEW.id) != 26
  OR substr(NEW.id, 1, 1) NOT GLOB '[0-7]'
  OR NEW.id GLOB '*[^0-9A-HJKMNP-TV-Z]*'
BEGIN
  SELECT RAISE(ABORT, 'fixture child id must be a ULID');
END;

CREATE TRIGGER IF NOT EXISTS workspaces_insert_collision
BEFORE INSERT ON workspaces
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM workspaces
  WHERE id = NEW.id OR slug = NEW.slug
)
BEGIN
  SELECT RAISE(ABORT, 'workspace registry rows cannot be replaced');
END;

CREATE TRIGGER IF NOT EXISTS workspaces_slug_collision
BEFORE UPDATE OF slug ON workspaces
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM workspaces
  WHERE slug = NEW.slug AND id IS NOT OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'workspace slug belongs to another registry row');
END;

UPDATE workspaces SET id = id;
UPDATE tenant_fixture_items SET id = id;
UPDATE tenant_fixture_children SET id = id;

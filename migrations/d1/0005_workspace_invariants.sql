-- ABOUTME: Hardens F04 tenant invariants: immutable workspace jurisdiction.
-- ABOUTME: Composite FK conventions remain owned by earlier migrations.

CREATE TRIGGER IF NOT EXISTS workspaces_jurisdiction_immutable
BEFORE UPDATE OF jurisdiction ON workspaces
FOR EACH ROW
WHEN NEW.jurisdiction IS NOT OLD.jurisdiction
BEGIN
  SELECT RAISE(ABORT, 'workspace jurisdiction is immutable');
END;

-- ABOUTME: Adds immutable random public notification identities without rewriting delivery or inbox history.
-- ABOUTME: Application cryptography assigns legacy NULL identities through the serialized Hub command lane.

ALTER TABLE notification_deliveries ADD COLUMN public_id TEXT
  CHECK (public_id IS NULL OR (
    typeof(public_id) = 'text' AND length(public_id) = 26
    AND instr(public_id, char(0)) = 0
    AND substr(public_id, 1, 1) GLOB '[0-7]'
    AND public_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ));

CREATE UNIQUE INDEX notification_public_identity
  ON notification_deliveries(public_id) WHERE public_id IS NOT NULL;

CREATE INDEX notification_missing_public_identity
  ON notification_deliveries(workspace_id, delivery_id) WHERE public_id IS NULL;

CREATE TRIGGER notification_public_identity_immutable
BEFORE UPDATE ON notification_deliveries
WHEN (OLD.public_id IS NOT NULL AND NEW.public_id IS NOT OLD.public_id)
  OR ((OLD.public_id IS NOT NULL OR NEW.public_id IS NOT NULL) AND (
    NEW.workspace_id IS NOT OLD.workspace_id
    OR NEW.delivery_id IS NOT OLD.delivery_id
    OR NEW.event_cursor IS NOT OLD.event_cursor
    OR NEW.channel IS NOT OLD.channel
    OR NEW.human_id IS NOT OLD.human_id
    OR NEW.runner_id IS NOT OLD.runner_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'notification identity is immutable');
END;

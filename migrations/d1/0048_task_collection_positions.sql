-- ABOUTME: Stores immutable hash-only browser task child positions with recipient, parent and capture binding.
-- ABOUTME: Additive metadata and write-only guards preserve existing child records and Hub atomic issuance.

CREATE TABLE task_collection_positions (
  position_hash TEXT NOT NULL CHECK (
    typeof(position_hash) = 'text' AND length(position_hash) = 64
    AND instr(position_hash, char(0)) = 0 AND position_hash NOT GLOB '*[^0-9a-f]*'
  ),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  human_id TEXT NOT NULL REFERENCES humans(id),
  authorization_epoch INTEGER NOT NULL CHECK (
    typeof(authorization_epoch) = 'integer' AND authorization_epoch BETWEEN 1 AND 9007199254740991
  ),
  projection_version INTEGER NOT NULL CHECK (projection_version = 1),
  page_limit INTEGER NOT NULL CHECK (typeof(page_limit) = 'integer' AND page_limit BETWEEN 1 AND 100),
  audience_json TEXT NOT NULL CHECK (
    json_valid(audience_json) AND json_type(audience_json) = 'array'
    AND length(CAST(audience_json AS BLOB)) <= 32768
  ),
  after_hash TEXT CHECK (after_hash IS NULL OR (
    typeof(after_hash) = 'text' AND length(after_hash) = 64
    AND instr(after_hash, char(0)) = 0 AND after_hash NOT GLOB '*[^0-9a-f]*'
  )),
  task_id TEXT NOT NULL CHECK (
    typeof(task_id) = 'text' AND length(task_id) = 26 AND instr(task_id, char(0)) = 0
    AND task_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  project_id TEXT NOT NULL CHECK (
    typeof(project_id) = 'text' AND length(project_id) = 26 AND instr(project_id, char(0)) = 0
    AND project_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  collection TEXT NOT NULL CHECK (collection IN ('comments', 'dependencies', 'links', 'runs')),
  capture_ceiling INTEGER NOT NULL CHECK (typeof(capture_ceiling) = 'integer' AND capture_ceiling >= 0),
  expires_at TEXT NOT NULL CHECK (
    typeof(expires_at) = 'text' AND length(expires_at) = 24 AND instr(expires_at, char(0)) = 0
    AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at
    AND date(substr(expires_at, 1, 10), '+0 days') IS substr(expires_at, 1, 10)
  ),
  anchor_id TEXT NOT NULL CHECK (
    typeof(anchor_id) = 'text' AND length(anchor_id) = 26 AND instr(anchor_id, char(0)) = 0
    AND anchor_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  anchor_rowid INTEGER NOT NULL CHECK (typeof(anchor_rowid) = 'integer' AND anchor_rowid >= 1),
  created_at TEXT NOT NULL CHECK (
    typeof(created_at) = 'text' AND length(created_at) = 24 AND instr(created_at, char(0)) = 0
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at
    AND date(substr(created_at, 1, 10), '+0 days') IS substr(created_at, 1, 10)
  ),
  PRIMARY KEY (workspace_id, position_hash),
  UNIQUE (position_hash)
);

CREATE INDEX task_collection_position_expiry ON task_collection_positions(expires_at);

CREATE TRIGGER task_collection_position_immutable
BEFORE UPDATE ON task_collection_positions
BEGIN
  SELECT RAISE(ABORT, 'task collection position is immutable');
END;

CREATE TABLE task_collection_position_guards (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  id TEXT NOT NULL,
  valid INTEGER NOT NULL CHECK (valid = 1),
  PRIMARY KEY (workspace_id, id)
);

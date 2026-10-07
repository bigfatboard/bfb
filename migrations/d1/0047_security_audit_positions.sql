-- ABOUTME: Stores immutable hash-only security-audit positions bound to current human audiences and canonical cuts.
-- ABOUTME: Write-only check guards make issuance atomic with the Hub without changing audit history or row identities.

CREATE TABLE security_audit_positions (
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
  capture_ceiling INTEGER NOT NULL CHECK (typeof(capture_ceiling) = 'integer' AND capture_ceiling >= 0),
  expires_at TEXT NOT NULL CHECK (
    typeof(expires_at) = 'text' AND length(expires_at) = 24 AND instr(expires_at, char(0)) = 0
    AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at
    AND date(substr(expires_at, 1, 10), '+0 days') IS substr(expires_at, 1, 10)
  ),
  anchor_audit_id TEXT NOT NULL CHECK (
    typeof(anchor_audit_id) = 'text' AND length(anchor_audit_id) = 26
    AND instr(anchor_audit_id, char(0)) = 0 AND anchor_audit_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  anchor_sort_key TEXT NOT NULL CHECK (
    typeof(anchor_sort_key) = 'text' AND length(anchor_sort_key) = 26
    AND instr(anchor_sort_key, char(0)) = 0
    AND substr(anchor_sort_key, 20, 1) = '.'
    AND substr(anchor_sort_key, 21) NOT GLOB '*[^0-9]*'
    AND strftime('%Y-%m-%dT%H:%M:%S', substr(anchor_sort_key, 1, 19) || 'Z') IS substr(anchor_sort_key, 1, 19)
    AND date(substr(anchor_sort_key, 1, 10), '+0 days') IS substr(anchor_sort_key, 1, 10)
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

CREATE INDEX security_audit_position_expiry ON security_audit_positions(expires_at);

CREATE TRIGGER security_audit_position_immutable
BEFORE UPDATE ON security_audit_positions
BEGIN
  SELECT RAISE(ABORT, 'security audit position is immutable');
END;

CREATE TABLE security_audit_position_guards (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  id TEXT NOT NULL,
  valid INTEGER NOT NULL CHECK (valid = 1),
  PRIMARY KEY (workspace_id, id)
);

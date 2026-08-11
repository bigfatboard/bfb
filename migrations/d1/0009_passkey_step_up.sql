-- ABOUTME: Adds Better Auth passkeys plus BFB-owned action-bound WebAuthn ceremonies.
-- ABOUTME: Security events retain bounded passkey enrollment, removal, and step-up outcomes.

CREATE TABLE better_auth_passkeys (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT,
  public_key TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES better_auth_users (id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  counter INTEGER NOT NULL CHECK (counter >= 0),
  device_type TEXT NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up INTEGER NOT NULL CHECK (backed_up IN (0, 1)),
  transports TEXT,
  created_at DATE,
  aaguid TEXT
);

CREATE INDEX better_auth_passkeys_user_id_idx ON better_auth_passkeys (user_id);

CREATE TABLE passkey_ceremonies (
  id TEXT NOT NULL PRIMARY KEY,
  human_id TEXT NOT NULL REFERENCES humans (id) ON DELETE RESTRICT,
  auth_user_id TEXT NOT NULL REFERENCES better_auth_users (id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES better_auth_sessions (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('registration', 'authentication')),
  state TEXT NOT NULL CHECK (
    state IN ('reauth_pending', 'ready', 'challenge_issued', 'failed', 'consumed')
  ),
  action_json TEXT NOT NULL,
  passkey_name TEXT,
  completion_hash TEXT,
  challenge TEXT,
  created_at TEXT NOT NULL,
  reauthenticated_at TEXT,
  expires_at TEXT NOT NULL,
  terminal_stamp TEXT
);

CREATE INDEX passkey_ceremonies_human_state_idx
  ON passkey_ceremonies (human_id, state, expires_at);

CREATE TABLE passkey_security_events (
  id TEXT NOT NULL PRIMARY KEY,
  human_id TEXT REFERENCES humans (id) ON DELETE RESTRICT,
  ceremony_id TEXT,
  kind TEXT NOT NULL CHECK (
    kind IN ('enrollment', 'removal', 'step_up')
  ),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  code TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX passkey_security_events_human_created_idx
  ON passkey_security_events (human_id, created_at);

-- ABOUTME: Adds the reviewed Better Auth 1.6.26 GitHub identity and session schema.
-- ABOUTME: Links normalized BFB humans to auth users and removes synthetic password sessions.

CREATE TABLE better_auth_users (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL,
  image TEXT,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL
);

CREATE TABLE better_auth_sessions (
  id TEXT NOT NULL PRIMARY KEY,
  expires_at DATE NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES better_auth_users (id) ON DELETE CASCADE
);

CREATE TABLE better_auth_accounts (
  id TEXT NOT NULL PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES better_auth_users (id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at DATE,
  refresh_token_expires_at DATE,
  scope TEXT,
  password TEXT,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL
);

CREATE TABLE better_auth_verifications (
  id TEXT NOT NULL PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at DATE NOT NULL,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL
);

CREATE INDEX better_auth_sessions_user_id_idx ON better_auth_sessions (user_id);
CREATE INDEX better_auth_accounts_user_id_idx ON better_auth_accounts (user_id);
CREATE UNIQUE INDEX better_auth_accounts_provider_account_uidx
  ON better_auth_accounts (provider_id, account_id);
CREATE INDEX better_auth_verifications_identifier_idx
  ON better_auth_verifications (identifier);

ALTER TABLE humans ADD COLUMN better_auth_user_id TEXT
  REFERENCES better_auth_users (id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX humans_better_auth_user_id_uidx ON humans (better_auth_user_id);

DROP TABLE human_sessions;
DROP TABLE human_credentials;

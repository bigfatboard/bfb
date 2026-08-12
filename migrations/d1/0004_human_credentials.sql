-- ABOUTME: Stores human password credential hashes for C02 email sign-in verification.
-- ABOUTME: Better Auth may own parallel protocol tables later; BFB verifies these hashes first.

CREATE TABLE IF NOT EXISTS human_credentials (
  human_id TEXT PRIMARY KEY NOT NULL,
  password_hash TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'scrypt',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (human_id) REFERENCES humans (id)
);

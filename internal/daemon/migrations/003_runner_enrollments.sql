-- ABOUTME: Persists non-secret workspace enrollment identity and durable runner command delivery references.
-- ABOUTME: Signing keys and tokens remain exclusively in Keychain and channel state never describes provider activity.

CREATE TABLE runner_enrollments (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    app_origin TEXT NOT NULL,
    device_label TEXT NOT NULL,
    public_key_json TEXT,
    key_thumbprint TEXT,
    connection_state TEXT NOT NULL CHECK (connection_state IN ('key_pending', 'pending_approval', 'connecting', 'online', 'offline', 'credential_unavailable', 'authorization_required', 'sync_blocked', 'revoked')),
    token_epoch INTEGER NOT NULL DEFAULT 0 CHECK (token_epoch >= 0),
    inventory_revision INTEGER NOT NULL DEFAULT 0 CHECK (inventory_revision >= 0),
    created_at TEXT NOT NULL,
    UNIQUE (app_origin, workspace_id)
) STRICT;

CREATE TABLE runner_command_inbox (
    runner_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    command_kind TEXT NOT NULL CHECK (command_kind IN ('launch', 'run_control', 'discussion_turn')),
    expires_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    accepted_at TEXT,
    PRIMARY KEY (runner_id, command_id),
    FOREIGN KEY (runner_id) REFERENCES runner_enrollments(id) ON DELETE CASCADE
) STRICT;

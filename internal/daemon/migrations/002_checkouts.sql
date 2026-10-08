-- ABOUTME: Records explicit local checkout identity and bounded non-secret observation metadata.
-- ABOUTME: Prevents duplicate physical-worktree links and retains unlink history without changing Git.

CREATE TABLE checkouts (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    runner_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    label TEXT NOT NULL,
    is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),
    registered_path TEXT NOT NULL,
    working_directory TEXT NOT NULL,
    git_root TEXT NOT NULL,
    git_directory TEXT NOT NULL,
    git_common_directory TEXT NOT NULL,
    workspace_subpath TEXT NOT NULL,
    cwd_identity TEXT NOT NULL,
    root_identity TEXT NOT NULL,
    git_identity TEXT NOT NULL,
    common_identity TEXT NOT NULL,
    remote_name TEXT NOT NULL,
    repository_identity TEXT NOT NULL,
    physical_worktree_hash TEXT NOT NULL,
    branch TEXT NOT NULL,
    head TEXT NOT NULL,
    dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
    canonical_config TEXT NOT NULL CHECK (json_valid(canonical_config)),
    repository_config_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('registered', 'validated', 'stale', 'blocked')),
    block_reason TEXT NOT NULL,
    validated_at TEXT NOT NULL,
    unlinked_at TEXT
) STRICT;

CREATE UNIQUE INDEX checkouts_physical_worktree
ON checkouts (physical_worktree_hash) WHERE unlinked_at IS NULL;

CREATE UNIQUE INDEX checkouts_default
ON checkouts (workspace_id, runner_id, project_id)
WHERE is_default = 1 AND unlinked_at IS NULL;

CREATE INDEX checkouts_workspace_page ON checkouts (workspace_id, id)
WHERE unlinked_at IS NULL;

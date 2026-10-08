-- ABOUTME: Keys the GitHub reconcile guard per object as well as stream.
-- ABOUTME: Out-of-order deliveries for another branch, PR, or check run converge independently.

PRAGMA defer_foreign_keys = ON;

-- The latest-wins guard was keyed per repository and stream, so an
-- out-of-order delivery for one object (a branch, PR, check run, issue,
-- deployment, or status context) was dropped as superseded by a newer
-- delivery for a different object in the same stream. The guard is now keyed
-- per object, so each object converges on its own cursor while deliveries
-- for the same object keep latest-wins ordering by payload timestamp.
-- Guard rows are convergence cursors only: deliveries already applied,
-- superseded, or ignored keep their recorded state, and redeliveries of the
-- same delivery id converge through that state, so prior rows are not
-- carried forward.
CREATE TABLE github_reconcile_state_new (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  repository_id TEXT NOT NULL CHECK (length(repository_id) BETWEEN 1 AND 64),
  stream TEXT NOT NULL CHECK (stream IN ('code', 'pull', 'check', 'issue', 'release')),
  ref TEXT NOT NULL CHECK (length(ref) BETWEEN 1 AND 512),
  last_event_time TEXT NOT NULL,
  last_delivery_id TEXT NOT NULL CHECK (length(last_delivery_id) BETWEEN 8 AND 128),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, repository_id, stream, ref)
);

DROP TABLE github_reconcile_state;

ALTER TABLE github_reconcile_state_new RENAME TO github_reconcile_state;

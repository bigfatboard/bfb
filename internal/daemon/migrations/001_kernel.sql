-- ABOUTME: Establishes daemon-local process observations for conservative restart recovery.
-- ABOUTME: Stores no human, runner, correlation, or provider credential material.

CREATE TABLE process_observations (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL CHECK (pid > 0),
    started_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('attached', 'unknown', 'ended'))
) STRICT;

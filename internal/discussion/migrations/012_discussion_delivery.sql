-- ABOUTME: Owns D02 supervised discussion delivery: session fencing, dispatch attempts, schedule and bounded outputs.
-- ABOUTME: Never duplicates D01 cloud records; every row references a D01 discussion, turn, or delivery identity.

CREATE TABLE IF NOT EXISTS discussion_ownership (
    discussion_id TEXT NOT NULL,
    slot INTEGER NOT NULL CHECK (slot IN (0, 1)),
    run_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'fake')),
    checkout_hash TEXT NOT NULL,
    owner_worker TEXT NOT NULL,
    fencing INTEGER NOT NULL CHECK (fencing >= 1),
    observed_session TEXT,
    state TEXT NOT NULL CHECK (state IN ('owned', 'released', 'paused')),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (discussion_id, slot)
) STRICT;

CREATE TRIGGER IF NOT EXISTS discussion_ownership_session_immutable
BEFORE UPDATE OF observed_session ON discussion_ownership
WHEN OLD.observed_session IS NOT NULL AND NEW.observed_session IS NOT OLD.observed_session
BEGIN
    SELECT RAISE(ABORT, 'discussion session binding is immutable');
END;

CREATE TABLE IF NOT EXISTS discussion_attempts (
    attempt_id TEXT PRIMARY KEY,
    discussion_id TEXT NOT NULL,
    slot INTEGER NOT NULL CHECK (slot IN (0, 1)),
    ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 6),
    turn_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    fencing INTEGER NOT NULL CHECK (fencing >= 1),
    kind TEXT NOT NULL CHECK (kind IN ('dispatch', 'acknowledge', 'complete', 'ambiguous', 'fail', 'cancel')),
    state TEXT NOT NULL CHECK (state IN ('recorded', 'effect_started', 'acknowledged', 'completed', 'failed', 'unknown', 'ambiguous')),
    session_id TEXT,
    effect_started INTEGER NOT NULL DEFAULT 0 CHECK (effect_started IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS discussion_attempts_turn_state
    ON discussion_attempts (discussion_id, slot, ordinal, state);

CREATE TRIGGER IF NOT EXISTS discussion_attempts_terminal_immutable
BEFORE UPDATE ON discussion_attempts
WHEN OLD.state IN ('completed', 'failed') AND NEW.state IS NOT OLD.state
BEGIN
    SELECT RAISE(ABORT, 'discussion terminal attempts are immutable');
END;

CREATE TABLE IF NOT EXISTS discussion_schedules (
    discussion_id TEXT PRIMARY KEY,
    rounds INTEGER NOT NULL CHECK (rounds BETWEEN 1 AND 3),
    deadline TEXT NOT NULL,
    stopped TEXT,
    stop_reason TEXT CHECK (stop_reason IN ('human_cancelled', 'deadline_exceeded', 'context_changed', 'sponsor_revoked', 'delivery_ambiguous', 'provider_failed')),
    completed_ordinals TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS discussion_outputs (
    discussion_id TEXT NOT NULL,
    slot INTEGER NOT NULL CHECK (slot IN (0, 1)),
    ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 6),
    attempt_id TEXT NOT NULL REFERENCES discussion_attempts (attempt_id),
    output_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (discussion_id, slot, ordinal)
) STRICT;

CREATE TABLE IF NOT EXISTS discussion_checkout_holders (
    checkout_hash TEXT PRIMARY KEY,
    discussion_id TEXT NOT NULL,
    slot INTEGER NOT NULL CHECK (slot IN (0, 1)),
    acquired_at TEXT NOT NULL
) STRICT;

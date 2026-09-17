// ABOUTME: Binds the first trusted SessionStart to exactly one observed provider session.
// ABOUTME: Exposes that binding through a narrow read interface for run-scoped consumers.

package journal

import (
	"context"
	"database/sql"
	"regexp"
)

// ObservedSession is the trusted provider-session binding for one immutable
// execution assignment. It carries only the observed session identity: no
// correlation secret, path, credential or provider payload.
type ObservedSession struct {
	Provider    string `json:"provider"`
	SessionID   string `json:"session_id"`
	RunID       string `json:"run_id"`
	ExecutionID string `json:"execution_id"`
	Generation  int64  `json:"generation"`
	BoundAt     string `json:"bound_at"`
}

// SessionReader is the narrow trusted-session read path consumed by A01's
// run-scoped local MCP. Implementations must return the durable binding or a
// typed failure; they never guess a current run or expose capture secrets.
type SessionReader interface {
	BoundSession(ctx context.Context, executionID string, generation int64) (ObservedSession, error)
}

var sessionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// BoundSession returns the observed provider session bound to an execution.
// An unbound execution reports session_unbound; it never invents a session.
func (store *Store) BoundSession(ctx context.Context, executionID string, generation int64) (ObservedSession, error) {
	var binding ObservedSession
	binding.ExecutionID = executionID
	binding.Generation = generation
	var provider, session, bound string
	err := store.db.QueryRowContext(ctx, "SELECT provider, session_id, bound_at FROM hook_observed_sessions WHERE execution_id = ? AND assignment_generation = ?", executionID, generation).Scan(&provider, &session, &bound)
	if err == sql.ErrNoRows {
		return ObservedSession{}, failure("session_unbound")
	}
	if err != nil {
		return ObservedSession{}, failure("storage_failed")
	}
	binding.Provider = provider
	binding.SessionID = session
	binding.BoundAt = bound
	if !sessionPattern.MatchString(binding.SessionID) || binding.Provider == "" {
		return ObservedSession{}, failure("session_unbound")
	}
	return binding, nil
}

// bindSession atomically records the first trusted SessionStart. Concurrent
// first sessions have exactly one winner; the losers observe the winner and
// must quarantine their competing session instead of rebinding the execution.
func bindSession(ctx context.Context, tx *sql.Tx, provider, session, execution string, generation int64, now string) (bound bool, winner string, err error) {
	if !sessionPattern.MatchString(session) || provider == "" {
		return false, "", failure("provider_event_invalid")
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO hook_observed_sessions (execution_id, assignment_generation, provider, session_id, bound_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(execution_id, assignment_generation) DO NOTHING", execution, generation, provider, session, now); err != nil {
		return false, "", failure("storage_failed")
	}
	var storedProvider, stored string
	if err := tx.QueryRowContext(ctx, "SELECT provider, session_id FROM hook_observed_sessions WHERE execution_id = ? AND assignment_generation = ?", execution, generation).Scan(&storedProvider, &stored); err != nil {
		return false, "", failure("storage_failed")
	}
	if stored != session || storedProvider != provider {
		return false, stored, nil
	}
	return true, stored, nil
}

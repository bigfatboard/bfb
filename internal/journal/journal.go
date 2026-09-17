// ABOUTME: Owns the durable hook journal: upload streams, events, dispositions and degraded state.
// ABOUTME: Deletes or quarantines rows only from explicit server dispositions, never from cursors.

package journal

import (
	"context"
	"database/sql"
	"time"

	"github.com/qdis/bfb/internal/daemon"
)

const maxJournalRows = 16384
const maxQuarantineRows = 4096
const maxUploadBatch = 64

// Store persists journaled events in the daemon SQLite database. The database
// connection must serialize writers; the daemon opens it with MaxOpenConns(1)
// and hook processes use short bounded transactions through the same file.
type Store struct {
	db *sql.DB
}

// NewStore wraps an opened daemon database. Migrations 009 and 010 must be applied.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// OpenState opens the daemon database for hook ingestion, applying pending
// migrations. Hook processes share this path with the running daemon through
// SQLite WAL; a busy database retries within the daemon busy timeout.
func OpenState(ctx context.Context, paths daemon.Paths) (*daemon.Store, error) {
	return daemon.OpenStore(ctx, paths)
}

func localTimestamp(now time.Time) string {
	return now.UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano)
}

// ensureEpoch returns the stable database epoch. One source stream is allocated
// per runner enrollment and database epoch, so a recreated database can never
// reuse a source sequence the server has already observed.
func (store *Store) ensureEpoch(ctx context.Context) (string, error) {
	var epoch string
	if err := store.db.QueryRowContext(ctx, "SELECT value FROM hook_journal_meta WHERE key = 'db_epoch'").Scan(&epoch); err != nil {
		return "", failure("storage_failed")
	}
	if epoch != "" {
		return epoch, nil
	}
	epoch = daemon.NewRequestID()
	if _, err := store.db.ExecContext(ctx, "UPDATE hook_journal_meta SET value = ? WHERE key = 'db_epoch' AND value = ''", epoch); err != nil {
		return "", failure("storage_failed")
	}
	if err := store.db.QueryRowContext(ctx, "SELECT value FROM hook_journal_meta WHERE key = 'db_epoch'").Scan(&epoch); err != nil || epoch == "" {
		return "", failure("storage_failed")
	}
	return epoch, nil
}

// streamForRunner returns the stable upload stream for one runner enrollment,
// rotating it when the database epoch changed underneath the stored row.
func (store *Store) streamForRunner(ctx context.Context, tx *sql.Tx, runner, epoch, now string) (string, error) {
	read := func() (string, string, error) {
		var stream, stored string
		err := txOrDB(ctx, store, tx).QueryRowContext(ctx, "SELECT stream_id, epoch FROM hook_source_streams WHERE runner_id = ?", runner).Scan(&stream, &stored)
		return stream, stored, err
	}
	exec := func(query string, args ...any) error {
		var err error
		if tx != nil {
			_, err = tx.ExecContext(ctx, query, args...)
		} else {
			_, err = store.db.ExecContext(ctx, query, args...)
		}
		return err
	}
	stream, stored, err := read()
	if err != nil && err != sql.ErrNoRows {
		return "", failure("storage_failed")
	}
	if err == nil && stored == epoch {
		return stream, nil
	}
	stream = daemon.NewRequestID()
	if err == sql.ErrNoRows {
		if err := exec("INSERT INTO hook_source_streams (runner_id, stream_id, epoch, next_attempt_at) VALUES (?, ?, ?, ?) ON CONFLICT(runner_id) DO NOTHING", runner, stream, epoch, now); err != nil {
			return "", failure("storage_failed")
		}
		stream, stored, err = read()
		if err != nil {
			return "", failure("storage_failed")
		}
		if stored == epoch {
			return stream, nil
		}
	}
	if err := exec("UPDATE hook_source_streams SET stream_id = ?, epoch = ?, next_sequence = 1, failures = 0, next_attempt_at = ? WHERE runner_id = ?", stream, epoch, now, runner); err != nil {
		return "", failure("storage_failed")
	}
	return stream, nil
}

type rowQuerier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func txOrDB(ctx context.Context, store *Store, tx *sql.Tx) rowQuerier {
	if tx != nil {
		return tx
	}
	return store.db
}

// Degraded reports the visible telemetry-degraded state with its bounded reason.
func (store *Store) Degraded(ctx context.Context) (bool, string, error) {
	var flag, reason string
	if err := store.db.QueryRowContext(ctx, "SELECT value FROM hook_journal_meta WHERE key = 'telemetry_degraded'").Scan(&flag); err != nil {
		return false, "", failure("storage_failed")
	}
	if err := store.db.QueryRowContext(ctx, "SELECT value FROM hook_journal_meta WHERE key = 'degraded_reason'").Scan(&reason); err != nil {
		return false, "", failure("storage_failed")
	}
	return flag == "1", reason, nil
}

func setDegraded(ctx context.Context, exec interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}, reason, now string) error {
	if len(reason) > 64 {
		reason = reason[:64]
	}
	if _, err := exec.ExecContext(ctx, "UPDATE hook_journal_meta SET value = '1' WHERE key = 'telemetry_degraded'"); err != nil {
		return failure("storage_failed")
	}
	if _, err := exec.ExecContext(ctx, "UPDATE hook_journal_meta SET value = ? WHERE key = 'degraded_reason'", reason); err != nil {
		return failure("storage_failed")
	}
	if _, err := exec.ExecContext(ctx, "UPDATE hook_journal_meta SET value = ? WHERE key = 'degraded_at'", now); err != nil {
		return failure("storage_failed")
	}
	return nil
}

func clearDegraded(ctx context.Context, exec interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}) error {
	if _, err := exec.ExecContext(ctx, "UPDATE hook_journal_meta SET value = '0' WHERE key = 'telemetry_degraded'"); err != nil {
		return failure("storage_failed")
	}
	if _, err := exec.ExecContext(ctx, "UPDATE hook_journal_meta SET value = '' WHERE key = 'degraded_reason'"); err != nil {
		return failure("storage_failed")
	}
	return nil
}

// Counts exposes pending, quarantined and stream totals for status and tests.
type Counts struct {
	Pending     int `json:"pending"`
	Quarantined int `json:"quarantined"`
	Streams     int `json:"streams"`
	Bindings    int `json:"bindings"`
}

// Counts reads journal totals without mutating delivery state.
func (store *Store) Counts(ctx context.Context) (Counts, error) {
	var counts Counts
	for _, query := range []struct {
		sql string
		out *int
	}{
		{"SELECT count(*) FROM hook_journal", &counts.Pending},
		{"SELECT count(*) FROM hook_quarantine", &counts.Quarantined},
		{"SELECT count(*) FROM hook_source_streams", &counts.Streams},
		{"SELECT count(*) FROM hook_observed_sessions", &counts.Bindings},
	} {
		if err := store.db.QueryRowContext(ctx, query.sql).Scan(query.out); err != nil {
			return Counts{}, failure("storage_failed")
		}
	}
	return counts, nil
}

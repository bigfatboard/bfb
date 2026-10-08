// ABOUTME: Defines the daemon-observed fact view imported through the durable journal sink.
// ABOUTME: Implementations supply local inspection facts; the journal owns import and upload.

package journal

import (
	"context"
	"database/sql"
	"time"
)

// Observation is one daemon-observed process fact awaiting journal import.
// Only local inspection supplies these; provider hooks can never assert them.
type Observation struct {
	EventID       string
	ExecutionID   string
	Generation    int64
	Sequence      int64
	Kind          string
	OccurredAt    string
	ProviderStart string
	Diagnostic    *string
}

// Observers reads pending daemon observations and records durable import.
// Production wraps the supervisor intent store; tests supply a fake.
type Observers interface {
	PendingObservations(ctx context.Context, limit int) ([]Observation, error)
	MarkImported(ctx context.Context, tx *sql.Tx, eventIDs []string, now time.Time) error
}

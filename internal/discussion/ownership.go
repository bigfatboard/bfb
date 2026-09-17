// ABOUTME: Pins one worker to each discussion participant with a monotonic fencing generation.
// ABOUTME: A duplicate worker never acquires ownership; a restart must reconcile before fencing advances.

package discussion

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"time"
)

var (
	ulidPattern    = regexp.MustCompile(`^[0-7][0-9A-HJKMNP-TV-Z]{25}$`)
	sessionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	worktreeDigest = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)

func validIdentity(value string) bool { return ulidPattern.MatchString(value) }

func validWorker(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for _, char := range value {
		if char < 32 || char == 127 {
			return false
		}
	}
	return true
}

func validProvider(value string) bool {
	return value == "claude" || value == "codex" || value == "fake"
}

// Ownership is the durable single-writer binding for one discussion participant.
type Ownership struct {
	DiscussionID    string
	Slot            int
	RunID           string
	Provider        string
	CheckoutHash    string
	OwnerWorker     string
	Fencing         int64
	ObservedSession string
	State           string
	Revision        int64
}

func scanOwnership(row *sql.Row) (Ownership, error) {
	var ownership Ownership
	var slot int
	var observed sql.NullString
	err := row.Scan(
		&ownership.DiscussionID, &slot, &ownership.RunID, &ownership.Provider,
		&ownership.CheckoutHash, &ownership.OwnerWorker, &ownership.Fencing,
		&observed, &ownership.State, &ownership.Revision,
	)
	if err == sql.ErrNoRows {
		return Ownership{}, err
	}
	if err != nil {
		return Ownership{}, failure("storage_failed")
	}
	ownership.Slot = slot
	if observed.Valid {
		ownership.ObservedSession = observed.String
	}
	return ownership, nil
}

// Acquire pins a worker to a participant slot. A second worker for the same
// slot fails with ownership_conflict, including after a restart: the new
// worker must reconcile through Reacquire instead.
func (store *Store) Acquire(ctx context.Context, discussionID string, slot int, runID, provider, checkoutHash, worker, now string) (Ownership, error) {
	if !validIdentity(discussionID) || !validIdentity(runID) || (slot != 0 && slot != 1) ||
		!validProvider(provider) || !worktreeDigest.MatchString(checkoutHash) || !validWorker(worker) {
		return Ownership{}, failure("invalid_request")
	}
	if _, err := time.Parse(time.RFC3339Nano, now); err != nil {
		return Ownership{}, failure("invalid_request")
	}
	_, err := store.db.ExecContext(ctx,
		`INSERT INTO discussion_ownership (discussion_id, slot, run_id, provider, checkout_hash, owner_worker, fencing, observed_session, state, revision, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, 1, NULL, 'owned', 1, ?)
		 ON CONFLICT (discussion_id, slot) DO NOTHING`,
		discussionID, slot, runID, provider, checkoutHash, worker, now)
	if err != nil {
		return Ownership{}, failure("storage_failed")
	}
	current, err := scanOwnership(store.db.QueryRowContext(ctx,
		`SELECT discussion_id, slot, run_id, provider, checkout_hash, owner_worker, fencing, observed_session, state, revision
		 FROM discussion_ownership WHERE discussion_id = ? AND slot = ?`, discussionID, slot))
	if err != nil {
		return Ownership{}, failure("storage_failed")
	}
	if current.OwnerWorker != worker || current.RunID != runID || current.Provider != provider || current.CheckoutHash != checkoutHash {
		return Ownership{}, failure("ownership_conflict")
	}
	if current.State == "released" {
		return Ownership{}, failure("recovery_pending")
	}
	return current, nil
}

// Owned returns the current ownership row for one participant.
func (store *Store) Owned(ctx context.Context, discussionID string, slot int) (Ownership, error) {
	current, err := scanOwnership(store.db.QueryRowContext(ctx,
		`SELECT discussion_id, slot, run_id, provider, checkout_hash, owner_worker, fencing, observed_session, state, revision
		 FROM discussion_ownership WHERE discussion_id = ? AND slot = ?`, discussionID, slot))
	if errors.Is(err, sql.ErrNoRows) {
		return Ownership{}, failure("ownership_required")
	}
	if err != nil {
		return Ownership{}, err
	}
	return current, nil
}

// CheckWriter verifies the calling worker still holds the current fencing
// generation. A superseded worker fails with fencing_stale and must stop.
func (store *Store) CheckWriter(ctx context.Context, discussionID string, slot int, worker string, fencing int64) (Ownership, error) {
	current, err := store.Owned(ctx, discussionID, slot)
	if err != nil {
		return Ownership{}, err
	}
	if current.OwnerWorker != worker || current.Fencing != fencing {
		return Ownership{}, failure("fencing_stale")
	}
	if current.State != "owned" {
		return Ownership{}, failure("discussion_stopped")
	}
	return current, nil
}

// BindSession records the first exact observed provider session for a
// participant. A competing session ID fails with session_conflict and never
// rebinds the participant; the helper reporting it must stop.
func (store *Store) BindSession(ctx context.Context, discussionID string, slot int, worker string, fencing int64, observed string) error {
	if !sessionPattern.MatchString(observed) {
		return failure("session_mismatch")
	}
	current, err := store.CheckWriter(ctx, discussionID, slot, worker, fencing)
	if err != nil {
		return err
	}
	if current.ObservedSession != "" {
		if current.ObservedSession != observed {
			return failure("session_conflict")
		}
		return nil
	}
	result, err := store.db.ExecContext(ctx,
		`UPDATE discussion_ownership SET observed_session = ?, revision = revision + 1, updated_at = ?
		 WHERE discussion_id = ? AND slot = ? AND observed_session IS NULL AND revision = ?`,
		observed, time.Now().UTC().Format(time.RFC3339Nano), discussionID, slot, current.Revision)
	if err != nil {
		return failure("storage_failed")
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return failure("session_conflict")
	}
	return nil
}

// Pause retains ownership and guards while stopping new turns. Cancellation,
// deadline, revocation, and ambiguous delivery all pause; none releases.
func (store *Store) Pause(ctx context.Context, discussionID string, slot int, worker string, fencing int64, now string) error {
	current, err := store.CheckWriter(ctx, discussionID, slot, worker, fencing)
	if err != nil {
		return err
	}
	if current.State == "owned" {
		if _, err := store.db.ExecContext(ctx,
			`UPDATE discussion_ownership SET state = 'paused', revision = revision + 1, updated_at = ?
			 WHERE discussion_id = ? AND slot = ? AND revision = ?`,
			now, discussionID, slot, current.Revision); err != nil {
			return failure("storage_failed")
		}
	}
	return nil
}

// Release frees ownership after every in-flight attempt has settled. Process
// uncertainty retains guards: unknown attempts block release.
func (store *Store) Release(ctx context.Context, discussionID string, slot int, worker string, fencing int64, now string) error {
	current, err := store.CheckWriter(ctx, discussionID, slot, worker, fencing)
	if err != nil {
		return err
	}
	var unsettled int
	if err := store.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM discussion_attempts
		 WHERE discussion_id = ? AND slot = ? AND state IN ('recorded', 'effect_started', 'acknowledged', 'unknown', 'ambiguous')`,
		discussionID, slot).Scan(&unsettled); err != nil {
		return failure("storage_failed")
	}
	if unsettled != 0 {
		return failure("recovery_pending")
	}
	if _, err := store.db.ExecContext(ctx,
		`UPDATE discussion_ownership SET state = 'released', revision = revision + 1, updated_at = ?
		 WHERE discussion_id = ? AND slot = ? AND revision = ?`,
		now, discussionID, slot, current.Revision); err != nil {
		return failure("storage_failed")
	}
	return nil
}

// Reacquire hands a reconciled participant to a fresh worker after a restart.
// It requires every in-flight attempt to be settled by Reopen first, then
// advances the fencing generation so the crashed worker's writes stay stale.
func (store *Store) Reacquire(ctx context.Context, discussionID string, slot int, worker, now string) (Ownership, error) {
	if !validWorker(worker) {
		return Ownership{}, failure("invalid_request")
	}
	current, err := store.Owned(ctx, discussionID, slot)
	if err != nil {
		return Ownership{}, err
	}
	if current.State == "released" {
		return Ownership{}, failure("invalid_request")
	}
	var unsettled int
	if err := store.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM discussion_attempts
		 WHERE discussion_id = ? AND slot = ? AND state IN ('recorded', 'effect_started', 'acknowledged', 'unknown')`,
		discussionID, slot).Scan(&unsettled); err != nil {
		return Ownership{}, failure("storage_failed")
	}
	if unsettled != 0 {
		return Ownership{}, failure("recovery_pending")
	}
	if _, err := store.db.ExecContext(ctx,
		`UPDATE discussion_ownership SET owner_worker = ?, fencing = fencing + 1, revision = revision + 1, updated_at = ?
		 WHERE discussion_id = ? AND slot = ? AND revision = ?`,
		worker, now, discussionID, slot, current.Revision); err != nil {
		return Ownership{}, failure("storage_failed")
	}
	return store.Owned(ctx, discussionID, slot)
}

// AcquireCheckout serializes participants that share one physical worktree.
// The second holder fails with checkout_occupied until the first releases.
func (store *Store) AcquireCheckout(ctx context.Context, checkoutHash, discussionID string, slot int, now string) error {
	if !worktreeDigest.MatchString(checkoutHash) || !validIdentity(discussionID) || (slot != 0 && slot != 1) {
		return failure("invalid_request")
	}
	_, err := store.db.ExecContext(ctx,
		`INSERT INTO discussion_checkout_holders (checkout_hash, discussion_id, slot, acquired_at)
		 VALUES (?, ?, ?, ?) ON CONFLICT (checkout_hash) DO NOTHING`,
		checkoutHash, discussionID, slot, now)
	if err != nil {
		return failure("storage_failed")
	}
	var holderDiscussion string
	var holderSlot int
	if err := store.db.QueryRowContext(ctx,
		`SELECT discussion_id, slot FROM discussion_checkout_holders WHERE checkout_hash = ?`,
		checkoutHash).Scan(&holderDiscussion, &holderSlot); err != nil {
		return failure("storage_failed")
	}
	if holderDiscussion != discussionID || holderSlot != slot {
		return failure("checkout_occupied")
	}
	return nil
}

// ReleaseCheckout frees a held worktree. Releasing another holder's checkout
// is rejected; only the recorded holder may release it.
func (store *Store) ReleaseCheckout(ctx context.Context, checkoutHash, discussionID string, slot int) error {
	result, err := store.db.ExecContext(ctx,
		`DELETE FROM discussion_checkout_holders WHERE checkout_hash = ? AND discussion_id = ? AND slot = ?`,
		checkoutHash, discussionID, slot)
	if err != nil {
		return failure("storage_failed")
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return failure("checkout_occupied")
	}
	return nil
}

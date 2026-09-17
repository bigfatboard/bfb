// ABOUTME: Records every dispatch attempt before its possible provider effect and correlates acknowledgements.
// ABOUTME: Reauthorizes each dispatch and plans read-only turns; peer content never reaches provider argv.

package discussion

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/qdis/bfb/internal/provider"
)

// Attempt is one durable typed step toward delivering a turn.
type Attempt struct {
	ID             string
	DiscussionID   string
	Slot           int
	Ordinal        int
	TurnID         string
	DeliveryID     string
	IdempotencyKey string
	Fencing        int64
	Kind           string
	State          string
	SessionID      string
	EffectStarted  bool
}

// AuthorityState is the current human authorization for a discussion.
type AuthorityState struct {
	Revoked bool
	Stopped bool
	Reason  string
}

// Authority reauthorizes each dispatch against current human authority.
// Production binds D01 sponsor epoch, grants, and run state; tests fake it.
type Authority interface {
	Authorize(ctx context.Context, discussionID string) (AuthorityState, error)
}

// TurnRequest is one supervised provider turn. RunID must equal the owned
// participant run; ExecutionID and Generation identify this turn's exact
// session binding for continuation.
type TurnRequest struct {
	DiscussionID    string
	TurnID          string
	DeliveryID      string
	Slot            int
	Ordinal         int
	Provider        string
	WorkingDir      string
	RunID           string
	ExecutionID     string
	Generation      int64
	ObservedSession string
	Fresh           bool
	ExternalContext []byte
	Worker          string
	Fencing         int64
	IdempotencyKey  string
}

// TurnResult is the observed provider outcome for one turn.
type TurnResult struct {
	ObservedSession   string
	Output            []byte
	ProviderEffect    bool
	ProviderEvidence  string
}

// Runner executes one planned turn behind the recorded attempt. The fake
// runner serves tests; the Codex adapter serves the bounded experiment.
type Runner interface {
	RunTurn(ctx context.Context, request TurnRequest, invocation provider.Invocation) (TurnResult, error)
}

// Planner compiles one read-only discussion turn through the certified L03 kit.
type Planner interface {
	PlanDiscussionTurn(providerName string, request TurnRequest) (provider.Invocation, error)
}

// RecordAttempt persists a dispatch attempt before any provider effect. A
// repeated idempotency key returns the original attempt; changed input under
// the same key fails with idempotency_conflict.
func (store *Store) RecordAttempt(ctx context.Context, request TurnRequest, fencing int64, now string) (Attempt, error) {
	if !validIdentity(request.DiscussionID) || !validIdentity(request.TurnID) ||
		!validIdentity(request.DeliveryID) || (request.Slot != 0 && request.Slot != 1) ||
		request.Ordinal < 1 || request.Ordinal > MaxTurns || !validWorker(request.IdempotencyKey) {
		return Attempt{}, failure("invalid_request")
	}
	attemptID := request.DeliveryID
	_, err := store.db.ExecContext(ctx,
		`INSERT INTO discussion_attempts (attempt_id, discussion_id, slot, ordinal, turn_id, delivery_id, idempotency_key, fencing, kind, state, session_id, effect_started, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dispatch', 'recorded', NULL, 0, ?, ?)
		 ON CONFLICT (attempt_id) DO NOTHING`,
		attemptID, request.DiscussionID, request.Slot, request.Ordinal, request.TurnID,
		request.DeliveryID, request.IdempotencyKey, fencing, now, now)
	if err != nil {
		return Attempt{}, failure("storage_failed")
	}
	attempt, err := store.ReadAttempt(ctx, attemptID)
	if err != nil {
		return Attempt{}, err
	}
	if attempt.DiscussionID != request.DiscussionID || attempt.Slot != request.Slot ||
		attempt.Ordinal != request.Ordinal || attempt.TurnID != request.TurnID ||
		attempt.IdempotencyKey != request.IdempotencyKey {
		return Attempt{}, failure("idempotency_conflict")
	}
	return attempt, nil
}

// ReadAttempt loads one attempt by its delivery identity.
func (store *Store) ReadAttempt(ctx context.Context, attemptID string) (Attempt, error) {
	var attempt Attempt
	var slot int
	var session sql.NullString
	err := store.db.QueryRowContext(ctx,
		`SELECT attempt_id, discussion_id, slot, ordinal, turn_id, delivery_id, idempotency_key, fencing, kind, state, session_id, effect_started
		 FROM discussion_attempts WHERE attempt_id = ?`, attemptID).Scan(
		&attempt.ID, &attempt.DiscussionID, &slot, &attempt.Ordinal, &attempt.TurnID,
		&attempt.DeliveryID, &attempt.IdempotencyKey, &attempt.Fencing, &attempt.Kind,
		&attempt.State, &session, &attempt.EffectStarted)
	if errors.Is(err, sql.ErrNoRows) {
		return Attempt{}, failure("attempt_required")
	}
	if err != nil {
		return Attempt{}, failure("storage_failed")
	}
	attempt.Slot = slot
	if session.Valid {
		attempt.SessionID = session.String
	}
	return attempt, nil
}

// MarkEffectStarted records that a provider effect may now exist. The crash
// window between this write and the acknowledgement is reconciled by Reopen,
// never by blind redispatch.
func (store *Store) MarkEffectStarted(ctx context.Context, attemptID, worker string, fencing int64, now string) error {
	attempt, err := store.ReadAttempt(ctx, attemptID)
	if err != nil {
		return err
	}
	if attempt.Fencing != fencing {
		return failure("fencing_stale")
	}
	if attempt.State != "recorded" {
		return failure("invalid_transition")
	}
	if _, err := store.CheckWriter(ctx, attempt.DiscussionID, attempt.Slot, worker, fencing); err != nil {
		return err
	}
	if _, err := store.db.ExecContext(ctx,
		`UPDATE discussion_attempts SET state = 'effect_started', effect_started = 1, updated_at = ?
		 WHERE attempt_id = ? AND state = 'recorded'`,
		now, attemptID); err != nil {
		return failure("storage_failed")
	}
	return nil
}

// Acknowledge binds the exact observed provider session to a started attempt.
// A wrong, busy, unowned, or revoked session fails without advancing state:
// wrong means it mismatches the owned binding, busy means another participant
// owns it, unowned means no ownership holds this slot, revoked is rejected by
// the authority check before this call.
func (store *Store) Acknowledge(ctx context.Context, attemptID, worker string, fencing int64, session string, now string) error {
	if !sessionPattern.MatchString(session) {
		return failure("session_mismatch")
	}
	attempt, err := store.ReadAttempt(ctx, attemptID)
	if err != nil {
		return err
	}
	if attempt.Fencing != fencing {
		return failure("fencing_stale")
	}
	if attempt.State != "effect_started" {
		return failure("invalid_transition")
	}
	ownership, err := store.CheckWriter(ctx, attempt.DiscussionID, attempt.Slot, worker, fencing)
	if err != nil {
		return err
	}
	if ownership.ObservedSession != "" && ownership.ObservedSession != session {
		return failure("session_mismatch")
	}
	var holder string
	err = store.db.QueryRowContext(ctx,
		`SELECT discussion_id FROM discussion_ownership WHERE observed_session = ? AND NOT (discussion_id = ? AND slot = ?)`,
		session, attempt.DiscussionID, attempt.Slot).Scan(&holder)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return failure("storage_failed")
	}
	if err == nil {
		return failure("session_busy")
	}
	if ownership.ObservedSession == "" {
		if err := store.BindSession(ctx, attempt.DiscussionID, attempt.Slot, worker, fencing, session); err != nil {
			return err
		}
	}
	if _, err := store.db.ExecContext(ctx,
		`UPDATE discussion_attempts SET state = 'acknowledged', session_id = ?, updated_at = ?
		 WHERE attempt_id = ? AND state = 'effect_started'`,
		session, now, attemptID); err != nil {
		return failure("storage_failed")
	}
	return nil
}

// CompleteAttempt closes an acknowledged attempt after its bounded output is stored.
func (store *Store) CompleteAttempt(ctx context.Context, attemptID, worker string, fencing int64, now string) error {
	attempt, err := store.ReadAttempt(ctx, attemptID)
	if err != nil {
		return err
	}
	if attempt.Fencing != fencing {
		return failure("fencing_stale")
	}
	if attempt.State != "acknowledged" {
		return failure("invalid_transition")
	}
	if _, err := store.CheckWriter(ctx, attempt.DiscussionID, attempt.Slot, worker, fencing); err != nil {
		return err
	}
	if _, err := store.db.ExecContext(ctx,
		`UPDATE discussion_attempts SET state = 'completed', updated_at = ? WHERE attempt_id = ? AND state = 'acknowledged'`,
		now, attemptID); err != nil {
		return failure("storage_failed")
	}
	return nil
}

// FailAttempt terminally fails an unsettled attempt with a typed reason.
func (store *Store) FailAttempt(ctx context.Context, attemptID, worker string, fencing int64, now string) error {
	attempt, err := store.ReadAttempt(ctx, attemptID)
	if err != nil {
		return err
	}
	if attempt.Fencing != fencing {
		return failure("fencing_stale")
	}
	switch attempt.State {
	case "completed", "failed":
		return failure("invalid_transition")
	}
	if _, err := store.CheckWriter(ctx, attempt.DiscussionID, attempt.Slot, worker, fencing); err != nil {
		return err
	}
	if _, err := store.db.ExecContext(ctx,
		`UPDATE discussion_attempts SET state = 'failed', updated_at = ? WHERE attempt_id = ?`,
		now, attemptID); err != nil {
		return failure("storage_failed")
	}
	return nil
}

// MarkUnknown flags an in-flight attempt after a crash made its provider
// effect uncertain. Unknown attempts retain guards and block redispatch.
func (store *Store) MarkUnknown(ctx context.Context, attemptID, now string) error {
	result, err := store.db.ExecContext(ctx,
		`UPDATE discussion_attempts SET state = 'unknown', updated_at = ?
		 WHERE attempt_id = ? AND state IN ('recorded', 'effect_started', 'acknowledged')`,
		now, attemptID)
	if err != nil {
		return failure("storage_failed")
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return failure("invalid_transition")
	}
	return nil
}

// MarkAmbiguous pauses an uncertain delivery visibly after reconciliation
// could not prove its outcome. An ambiguous delivery is never retried blindly.
func (store *Store) MarkAmbiguous(ctx context.Context, attemptID, worker string, fencing int64, now string) error {
	attempt, err := store.ReadAttempt(ctx, attemptID)
	if err != nil {
		return err
	}
	if attempt.Fencing != fencing {
		return failure("fencing_stale")
	}
	if attempt.State != "unknown" && attempt.State != "effect_started" && attempt.State != "acknowledged" {
		return failure("invalid_transition")
	}
	if _, err := store.CheckWriter(ctx, attempt.DiscussionID, attempt.Slot, worker, fencing); err != nil {
		// A paused owner still reconciles ambiguity: ownership outlives the turn.
		if Code(err) != "discussion_stopped" {
			return err
		}
	}
	if _, err := store.db.ExecContext(ctx,
		`UPDATE discussion_attempts SET state = 'ambiguous', updated_at = ? WHERE attempt_id = ?`,
		now, attemptID); err != nil {
		return failure("storage_failed")
	}
	if err := store.Pause(ctx, attempt.DiscussionID, attempt.Slot, worker, fencing, now); err != nil {
		if Code(err) != "discussion_stopped" {
			return err
		}
	}
	_ = store.StopSchedule(ctx, attempt.DiscussionID, now, "delivery_ambiguous", now)
	return nil
}

// assertReadOnlyPlan verifies the compiled turn cannot write: the certified
// adapter planned it read-only, and no peer byte reached argv or environment.
func assertReadOnlyPlan(invocation provider.Invocation, peer []byte) error {
	for _, argument := range invocation.Arguments {
		if argument == "" || len(argument) > 8192 {
			return failure("provider_discussion_unsafe")
		}
	}
	if len(peer) != 0 {
		for _, field := range append(append([]string{}, invocation.Arguments...), invocation.Environment...) {
			if field != "" && bytes.Contains([]byte(field), peer) {
				return failure("peer_escalation")
			}
		}
	}
	return nil
}

// DispatchTurn conducts one supervised turn: reauthorize, verify schedule and
// ownership, serialize the checkout, record the attempt before the effect,
// plan the read-only turn, run it, acknowledge the exact session, validate
// the bounded output, and complete. Any crash between effect start and
// acknowledgement leaves a reconcilable attempt instead of a duplicate turn.
func DispatchTurn(ctx context.Context, store *Store, planner Planner, authority Authority, runner Runner, request TurnRequest, sources []string, contextIDs map[string]bool, revision, now string) error {
	if _, err := time.Parse(time.RFC3339Nano, now); err != nil {
		return failure("invalid_request")
	}
	if request.Provider != "fake" && request.Provider != "codex" && request.Provider != "claude" {
		return failure("provider_unsupported")
	}
	state, err := authority.Authorize(ctx, request.DiscussionID)
	if err != nil {
		return failure("authority_unavailable")
	}
	if state.Revoked {
		return failure("revoked")
	}
	if state.Stopped {
		return failure("discussion_stopped")
	}
	if err := store.RequireTurnReady(ctx, request.DiscussionID, request.Slot, request.Ordinal, now); err != nil {
		return err
	}
	ownership, err := store.CheckWriter(ctx, request.DiscussionID, request.Slot, request.Worker, request.Fencing)
	if err != nil {
		return err
	}
	if ownership.Provider != request.Provider {
		return failure("provider_mismatch")
	}
	if request.RunID != ownership.RunID || !validIdentity(request.ExecutionID) || request.Generation < 1 {
		return failure("session_mismatch")
	}
	if request.ObservedSession != "" {
		if ownership.ObservedSession != "" && ownership.ObservedSession != request.ObservedSession {
			return failure("session_mismatch")
		}
		if ownership.ObservedSession == "" && request.Fresh {
			return failure("session_mismatch")
		}
	} else if !request.Fresh {
		return failure("session_mismatch")
	}
	if err := store.AcquireCheckout(ctx, ownership.CheckoutHash, request.DiscussionID, request.Slot, now); err != nil {
		return err
	}
	releaseCheckout := true
	defer func() {
		if releaseCheckout {
			_ = store.ReleaseCheckout(ctx, ownership.CheckoutHash, request.DiscussionID, request.Slot)
		}
	}()
	attempt, err := store.RecordAttempt(ctx, request, request.Fencing, now)
	if err != nil {
		return err
	}
	if attempt.State == "completed" {
		return failure("invalid_transition")
	}
	if attempt.State != "recorded" {
		return failure("delivery_unknown")
	}
	invocation, err := planner.PlanDiscussionTurn(request.Provider, request)
	if err != nil {
		return err
	}
	if err := assertReadOnlyPlan(invocation, request.ExternalContext); err != nil {
		return err
	}
	if err := store.MarkEffectStarted(ctx, attempt.ID, request.Worker, request.Fencing, now); err != nil {
		return err
	}
	result, err := runner.RunTurn(ctx, request, invocation)
	if err != nil {
		// The effect may have started: reconcile through Reopen, never retry here.
		return failure("delivery_unknown")
	}
	observed := result.ObservedSession
	if observed == "" {
		return failure("session_mismatch")
	}
	if request.ObservedSession != "" && request.ObservedSession != observed {
		return failure("session_mismatch")
	}
	if err := store.Acknowledge(ctx, attempt.ID, request.Worker, request.Fencing, observed, now); err != nil {
		return err
	}
	validated, err := ValidateRecommendation(result.Output, sources, contextIDs, revision)
	if err != nil {
		_ = store.FailAttempt(ctx, attempt.ID, request.Worker, request.Fencing, now)
		_ = store.StopSchedule(ctx, request.DiscussionID, now, "provider_failed", now)
		return err
	}
	if err := store.StoreOutput(ctx, request.DiscussionID, request.Slot, request.Ordinal, attempt.ID, validated, now); err != nil {
		return err
	}
	if err := store.CompleteAttempt(ctx, attempt.ID, request.Worker, request.Fencing, now); err != nil {
		return err
	}
	if err := store.MarkCompleted(ctx, request.DiscussionID, request.Ordinal, now); err != nil {
		return err
	}
	releaseCheckout = false
	return store.ReleaseCheckout(ctx, ownership.CheckoutHash, request.DiscussionID, request.Slot)
}

// CancelDiscussion stops a discussion and pauses its owners. In-flight
// attempts keep their guards: cancellation prevents new turns and terminates
// owned work safely without inventing outcomes.
func CancelDiscussion(ctx context.Context, store *Store, authority Authority, discussionID, worker string, fencing int64, reason, now string) error {
	if reason != "human_cancelled" && reason != "sponsor_revoked" {
		return failure("invalid_request")
	}
	state, err := authority.Authorize(ctx, discussionID)
	if err != nil {
		return failure("authority_unavailable")
	}
	if state.Revoked && reason != "sponsor_revoked" {
		return failure("revoked")
	}
	for slot := 0; slot < 2; slot++ {
		ownership, err := store.Owned(ctx, discussionID, slot)
		if err != nil {
			continue
		}
		if ownership.OwnerWorker != worker || ownership.Fencing != fencing {
			return failure("fencing_stale")
		}
		_ = store.Pause(ctx, discussionID, slot, worker, fencing, now)
	}
	_ = store.StopSchedule(ctx, discussionID, now, reason, now)
	return nil
}

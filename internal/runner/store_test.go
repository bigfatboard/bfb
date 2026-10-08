// ABOUTME: Verifies durable enrollment reservation, crash recovery and command acceptance boundaries.
// ABOUTME: Exercises real SQLite transactions and ensures neither expiration nor missing consumers drops work.

package runner

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/auth"
	"github.com/qdis/bfb/internal/daemon"
)

func runnerStore(t *testing.T) (*Store, daemon.Paths) {
	t.Helper()
	directory, err := os.MkdirTemp("", "bfb-runner-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	paths, err := daemon.StatePaths(directory)
	if err != nil {
		t.Fatal(err)
	}
	if err = paths.Prepare(); err != nil {
		t.Fatal(err)
	}
	local, err := daemon.OpenStore(context.Background(), paths)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = local.Close() })
	return NewStore(local.DB), paths
}

func savedEnrollment(t *testing.T, store *Store) (Enrollment, *memoryCredentials) {
	t.Helper()
	input, credentials := testEnrollment(t)
	enrollment, err := store.Begin(context.Background(), input.Origin, input.WorkspaceID, input.Label)
	if err != nil {
		t.Fatal(err)
	}
	enrollment, err = store.CompleteKey(context.Background(), enrollment, credentials)
	if err != nil {
		t.Fatal(err)
	}
	return enrollment, credentials
}

func TestEnrollmentKeyReservationAndRecovery(t *testing.T) {
	ctx := context.Background()
	store, paths := runnerStore(t)
	input, credentials := testEnrollment(t)
	reserved, err := store.Begin(ctx, input.Origin, input.WorkspaceID, input.Label)
	if err != nil || reserved.State != "key_pending" {
		t.Fatal(reserved, err)
	}
	// Simulate process loss after Keychain creation but before SQLite publication.
	ref := auth.CredentialRef{Kind: auth.RunnerKey, WorkspaceID: reserved.WorkspaceID, ID: reserved.RunnerID}
	public, err := credentials.CreateKey(ctx, ref)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.db.Close(); err != nil {
		t.Fatal(err)
	}
	local, err := daemon.OpenStore(ctx, paths)
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()
	store = NewStore(local.DB)
	again, err := store.Begin(ctx, input.Origin, input.WorkspaceID, input.Label)
	if err != nil || again.RunnerID != reserved.RunnerID {
		t.Fatal("lost durable reservation", err)
	}
	completed, err := store.CompleteKey(ctx, again, credentials)
	if err != nil || string(completed.PublicKey) != string(public) {
		t.Fatal("rotated a reserved key", err)
	}
	if err := store.SaveEpoch(ctx, completed.RunnerID, 7); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveEpoch(ctx, completed.RunnerID, 7); err != ErrAuthorization {
		t.Fatal("duplicate epoch accepted", err)
	}
	if err := store.SetState(ctx, completed.RunnerID, "online"); err != nil {
		t.Fatal(err)
	}
	if err := store.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	observed, _ := store.Get(ctx, completed.RunnerID)
	if observed.State != "offline" || observed.TokenEpoch != 7 || observed.Thumbprint != completed.Thumbprint {
		t.Fatal("recovery changed authority or fabricated connectivity")
	}
	if err := store.SetState(ctx, completed.RunnerID, "revoked"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetState(ctx, completed.RunnerID, "online"); err != ErrRevoked {
		t.Fatal("resurrected revoked enrollment", err)
	}
	if _, err := store.Begin(ctx, input.Origin, input.WorkspaceID, input.Label); err != ErrRevoked {
		t.Fatal("re-enrolled a revoked identity", err)
	}
}

func TestCommandReceiptCrashAndMissingConsumer(t *testing.T) {
	ctx := context.Background()
	store, paths := runnerStore(t)
	enrollment, _ := savedEnrollment(t, store)
	command := CommandReference{ID: daemon.NewRequestID(), Kind: "launch", ExpiresAt: time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)}
	if err := store.Receive(ctx, enrollment.RunnerID, []CommandReference{command, command}); err != nil {
		t.Fatal(err)
	}
	if err := store.Deliver(ctx, enrollment, nil); err != nil {
		t.Fatal(err)
	}
	var pending int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM runner_command_inbox WHERE accepted_at IS NULL`).Scan(&pending); err != nil || pending != 1 {
		t.Fatal("missing consumer or expiry discarded work", pending, err)
	}
	// An owning consumer commits, then the process loses the receipt. Its stable
	// command key prevents repeating the business effect on the next delivery.
	_, err := store.db.Exec(`CREATE TABLE synthetic_acceptances (id TEXT PRIMARY KEY)`)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	consumer := func(ctx context.Context, _ Enrollment, reference CommandReference) error {
		calls++
		_, err := store.db.ExecContext(ctx, `INSERT INTO synthetic_acceptances (id) VALUES (?) ON CONFLICT DO NOTHING`, reference.ID)
		if err == nil && calls == 1 {
			return errors.New("synthetic process loss after business commit")
		}
		return err
	}
	consumers := map[string]CommandConsumer{"launch": consumer}
	if err := store.Deliver(ctx, enrollment, consumers); err == nil {
		t.Fatal("ambiguous acceptance acknowledged")
	}
	_ = store.db.Close()
	local, err := daemon.OpenStore(ctx, paths)
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()
	store = NewStore(local.DB)
	for range 3 {
		if err := store.Receive(ctx, enrollment.RunnerID, []CommandReference{command}); err != nil {
			t.Fatal(err)
		}
		if err := store.Deliver(ctx, enrollment, consumers); err != nil {
			t.Fatal(err)
		}
	}
	var effects int
	_ = store.db.QueryRow(`SELECT COUNT(*) FROM synthetic_acceptances`).Scan(&effects)
	if effects != 1 || calls != 2 {
		t.Fatal("business effect or accepted receipt duplicated", effects, calls)
	}
	changed := command
	changed.Kind = "discussion_turn"
	if err := store.Receive(ctx, enrollment.RunnerID, []CommandReference{changed}); err != ErrProtocol {
		t.Fatal("command changed identity", err)
	}
	if err := store.SetState(ctx, enrollment.RunnerID, "revoked"); err != nil {
		t.Fatal(err)
	}
	if err := store.Deliver(ctx, enrollment, consumers); err != ErrRevoked {
		t.Fatal("revocation did not fence inbox", err)
	}
}

func TestEnrollmentAndInboxBounds(t *testing.T) {
	ctx := context.Background()
	store, _ := runnerStore(t)
	enrollment, _ := savedEnrollment(t, store)
	for index := 1; index < 16; index++ {
		if _, err := store.Begin(ctx, "https://bfb.synthetic.test", daemon.NewRequestID(), fmt.Sprintf("Mac %d", index)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.Begin(ctx, "https://bfb.synthetic.test", daemon.NewRequestID(), "Overflow"); err != ErrProtocol {
		t.Fatal("unbounded enrollment count", err)
	}
	for index := 0; index < 256; index++ {
		command := CommandReference{ID: daemon.NewRequestID(), Kind: "run_control", ExpiresAt: "2026-09-12T00:00:00Z"}
		if err := store.Receive(ctx, enrollment.RunnerID, []CommandReference{command}); err != nil {
			t.Fatal(err)
		}
	}
	command := CommandReference{ID: daemon.NewRequestID(), Kind: "launch", ExpiresAt: "2026-09-12T00:00:00Z"}
	if err := store.Receive(ctx, enrollment.RunnerID, []CommandReference{command}); err != ErrProtocol {
		t.Fatal("unbounded pending inbox", err)
	}
	if _, err := store.db.Exec(`UPDATE runner_command_inbox SET accepted_at = '2026-09-12T00:00:00Z'`); err != nil {
		t.Fatal(err)
	}
	// The receipt count has an independent cap; no delivery cursor deletes it.
	if _, err := store.db.Exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<3840) INSERT INTO runner_command_inbox (runner_id,command_id,command_kind,expires_at,received_at,accepted_at) SELECT ?, 'synthetic-' || x, 'launch', '2026-09-12T00:00:00Z', '2026-09-12T00:00:00Z', '2026-09-12T00:00:00Z' FROM n`, enrollment.RunnerID); err != nil {
		t.Fatal(err)
	}
	if err := store.Receive(ctx, enrollment.RunnerID, []CommandReference{command}); err != ErrProtocol {
		t.Fatal("unbounded acceptance receipts", err)
	}
}

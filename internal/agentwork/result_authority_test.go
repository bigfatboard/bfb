// ABOUTME: Tests bounded asynchronous result confirmation and strict original timing under cloud outages.
// ABOUTME: Prevents denial races, task-proof substitution and renewable fields from widening captured authority.

package agentwork

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
)

func TestResultAuthorityOnlyFreshnessAndEligibilityMayChangeForOriginalRetry(t *testing.T) {
	original, _, _, _ := resultFactoryFixture(t)
	mutable := map[string]bool{"ConfirmationId": true, "ConfirmedAt": true, "LeaseExpiresAt": true, "CredentialExpiresAt": true, "RunnerTokenEpoch": true, "CanSubmit": true}
	fields := reflect.TypeOf(original)
	for index := 0; index < fields.NumField(); index++ {
		name := fields.Field(index).Name
		t.Run(name, func(t *testing.T) {
			var changed generated.AgentResultConfirmationResult
			_ = json.Unmarshal([]byte(workTestJSON(t, original)), &changed)
			field := reflect.ValueOf(&changed).Elem().Field(index)
			switch field.Kind() {
			case reflect.Bool:
				field.SetBool(!field.Bool())
			case reflect.Int64:
				field.SetInt(field.Int() + 1)
			case reflect.String:
				if strings.HasPrefix(field.String(), "sha256:") {
					field.SetString("sha256:" + strings.Repeat("f", 64))
				} else {
					field.SetString("changed")
				}
			case reflect.Struct:
				changed.Binding.ProviderSessionId = workOtherID
			case reflect.Map:
				changed.ConfiguredPermission = map[string]any{"allow_submit_result": false, "max_pending_age_seconds": 0}
			default:
				t.Fatal("unhandled authority field", name)
			}
			if sameResultCaptureAuthority(original, changed) != mutable[name] {
				t.Fatal("authority comparison", name)
			}
		})
	}
}

func TestResultAuthorityOutageRetainsOriginalSendHorizon(t *testing.T) {
	f := newResultServiceFixture(t, true)
	authority := f.service.results
	requests := 0
	authority.connection = func(string) (runner.RunnerConnection, error) {
		return workAuthorityConnection{f.cloud, func(ctx context.Context, method, action string, body []byte) ([]byte, error) {
			requests++
			if requests == 1 {
				f.clock.set(44*time.Second, nil)
			}
			return f.cloud.Request(ctx, method, action, body)
		}}, nil
	}
	first, online, err := authority.confirm(context.Background(), f.reference, *f.input.ExpectedBinding, false)
	if err != nil || !online || first.timing.sent != 0 || first.timing.received != 44*time.Second {
		t.Fatal(first, online, err)
	}
	f.cloud.confirmationErr = runner.ErrOffline
	f.clock.set(44*time.Second+500*time.Millisecond, nil)
	cached, online, err := authority.confirm(context.Background(), f.reference, *f.input.ExpectedBinding, true)
	if err != nil || online || cached.timing != first.timing || cached.value.ConfirmationId != first.value.ConfirmationId {
		t.Fatal("fallback reset capture proof", cached, err)
	}
	f.clock.set(45*time.Second, nil)
	if _, _, err := authority.confirm(context.Background(), f.reference, *f.input.ExpectedBinding, true); err == nil {
		t.Fatal("exact45s admitted")
	}
	if _, found := authority.cached(confirmationKey(f.reference, *f.input.ExpectedBinding)); found {
		t.Fatal("expired proof retained")
	}
}

func TestResultAuthorityKnownDenialFencesLatePublication(t *testing.T) {
	f := newResultServiceFixture(t, true)
	authority := f.service.results
	started, release := make(chan struct{}), make(chan struct{})
	authority.connection = func(string) (runner.RunnerConnection, error) {
		return workAuthorityConnection{f.cloud, func(ctx context.Context, method, action string, body []byte) ([]byte, error) {
			close(started)
			select {
			case <-release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			return f.cloud.Request(ctx, method, action, body)
		}}, nil
	}
	finished := make(chan error, 1)
	go func() {
		_, _, err := authority.confirm(context.Background(), f.reference, *f.input.ExpectedBinding, false)
		finished <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("confirmation did not start")
	}
	authority.invalidateOnDenial(&daemon.Failure{Code: "revoked"})
	close(release)
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("late proof published after denial")
		}
	case <-time.After(time.Second):
		t.Fatal("late confirmation hung")
	}
	if _, found := authority.cached(confirmationKey(f.reference, *f.input.ExpectedBinding)); found {
		t.Fatal("denied proof cached")
	}
}

func TestResultAuthorityPrimingIsBoundedSingleFlightAndCancellable(t *testing.T) {
	f := newResultServiceFixture(t, true)
	authority := f.service.results
	started := make(chan struct{}, 1)
	authority.connection = func(string) (runner.RunnerConnection, error) {
		return workAuthorityConnection{f.cloud, func(ctx context.Context, _, _ string, _ []byte) ([]byte, error) {
			select {
			case started <- struct{}{}:
			default:
			}
			<-ctx.Done()
			return nil, ctx.Err()
		}}, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	authority.start(ctx)
	authority.schedule(f.reference, *f.input.ExpectedBinding)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("prime did not start")
	}
	// Priming stays outside the A01 work mutex, even when its network call stalls.
	f.service.mu.Lock()
	for index := 0; index < 100; index++ {
		authority.schedule(f.reference, *f.input.ExpectedBinding)
	}
	for index := 0; index < 100; index++ {
		ref := f.reference
		ref.AssignmentGeneration += int64(index + 1)
		authority.schedule(ref, *f.input.ExpectedBinding)
	}
	f.service.mu.Unlock()
	authority.mu.Lock()
	queued, pending := len(authority.queue), len(authority.pending)
	authority.mu.Unlock()
	if queued != 16 || pending != 17 {
		t.Fatal("prime queue/single-flight bounds", queued, pending)
	}
	cancel()
	select {
	case <-authority.done:
	case <-time.After(time.Second):
		t.Fatal("prime worker did not join cancellation")
	}
	if len(authority.confirmations) != 0 {
		t.Fatal("cancelled prime published proof")
	}
}

func TestResultAuthorityValidPrimeDoesNotRefreshProofAndCacheIsBounded(t *testing.T) {
	f := newResultServiceFixture(t, true)
	authority := f.service.results
	first, _, err := authority.confirm(context.Background(), f.reference, *f.input.ExpectedBinding, false)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	authority.start(ctx)
	for index := 0; index < 100; index++ {
		authority.schedule(f.reference, *f.input.ExpectedBinding)
	}
	cancel()
	<-authority.done
	cached, found := authority.cached(confirmationKey(f.reference, *f.input.ExpectedBinding))
	if !found || cached.timing != first.timing || f.cloud.confirmations != 1 {
		t.Fatal("valid proof was refreshed")
	}
	authority.mu.Lock()
	for index := 0; index < 1024; index++ {
		authority.confirmations[fmt.Sprint(index)] = first
	}
	authority.mu.Unlock()
	if _, _, err := authority.confirm(context.Background(), f.reference, *f.input.ExpectedBinding, false); err != nil {
		t.Fatal(err)
	}
	if len(authority.confirmations) != 1 {
		t.Fatal("unbounded confirmation cache", len(authority.confirmations))
	}
}

func TestResultAuthorityOutagePostflightDenialInvalidatesProof(t *testing.T) {
	f := newResultServiceFixture(t, true)
	authority := f.service.results
	if _, _, err := authority.confirm(context.Background(), f.reference, *f.input.ExpectedBinding, false); err != nil {
		t.Fatal(err)
	}
	f.cloud.confirmationErr = runner.ErrOffline
	inspect := authority.inspect
	calls := 0
	authority.inspect = func(ctx context.Context, ref generated.AgentWorkRequest, binding generated.AgentSessionReference) (generated.LaunchClaimResult, error) {
		calls++
		claim, err := inspect(ctx, ref, binding)
		if calls == 2 {
			claim.FencingGeneration++
		}
		return claim, err
	}
	if _, _, err := authority.confirm(context.Background(), f.reference, *f.input.ExpectedBinding, true); daemon.AsFailure(err).Code != "assignment_ended" {
		t.Fatal(err)
	}
	if _, found := authority.cached(confirmationKey(f.reference, *f.input.ExpectedBinding)); found {
		t.Fatal("replaced claim retained proof")
	}
}

func TestResultAuthorityTaskDenialInvalidatesButTransientFailureDoesNot(t *testing.T) {
	for _, reason := range []string{"revoked", "policy_rejected", "offline_rejected"} {
		t.Run(reason, func(t *testing.T) {
			f := newResultServiceFixture(t, true)
			authority := f.service.results
			if _, _, err := authority.confirm(context.Background(), f.reference, *f.input.ExpectedBinding, false); err != nil {
				t.Fatal(err)
			}
			authority.invalidateOnDenial(&daemon.Failure{Code: reason})
			_, found := authority.cached(confirmationKey(f.reference, *f.input.ExpectedBinding))
			if found != (reason == "offline_rejected") {
				t.Fatal("denial cache lifecycle", reason, found)
			}
		})
	}
}

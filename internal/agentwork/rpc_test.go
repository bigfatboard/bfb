// ABOUTME: Requires the fresh ownership fence and maps its bounded denials at the agent bridge.
// ABOUTME: Separates terminal access closure from retryable local storage or daemon availability faults.

package agentwork

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
)

func TestAgentBridgeRequiresOwnershipFence(t *testing.T) {
	if err := RegisterRPC(daemon.NewRegistry(), nil, nil); daemon.AsFailure(err).Code != "invalid_request" {
		t.Fatal("agent bridge registered without a production ownership check", err)
	}
}

func TestAgentOwnershipFailureMapping(t *testing.T) {
	for input, expected := range map[string]string{
		"execution_assignment_invalid": "assignment_ended", "containment_unknown": "assignment_ended",
		"storage_failed": "storage_failed", "daemon_offline": "offline_rejected",
	} {
		if actual := daemon.AsFailure(ownershipError(&daemon.Failure{Code: input})).Code; actual != expected {
			t.Fatal("native denial classification changed", input, actual)
		}
	}
}

func TestLegacyRPCNativeDenialFencesResultProof(t *testing.T) {
	for _, mode := range []string{"cached", "in_flight"} {
		t.Run(mode, func(t *testing.T) {
			f := newResultServiceFixture(t, true)
			authority := f.service.results
			key := confirmationKey(f.reference, *f.input.ExpectedBinding)
			if _, _, err := authority.confirm(context.Background(), f.reference, *f.input.ExpectedBinding, false); err != nil {
				t.Fatal(err)
			}
			generation := authority.currentGeneration()
			var release chan struct{}
			var finished chan error
			if mode == "in_flight" {
				started := make(chan struct{})
				release, finished = make(chan struct{}), make(chan error, 1)
				done := make(chan struct{})
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				t.Cleanup(func() {
					cancel()
					select {
					case <-done:
					case <-time.After(time.Second):
						t.Error("result confirmation did not join cleanup")
					}
				})
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
				go func() {
					defer close(done)
					_, _, err := authority.confirm(ctx, f.reference, *f.input.ExpectedBinding, false)
					finished <- err
				}()
				select {
				case <-started:
				case <-ctx.Done():
					t.Fatal("result confirmation did not start")
				}
			}
			registry := daemon.NewRegistry()
			if err := registerWorkRPC(registry, f.service); err != nil {
				t.Fatal(err)
			}
			// A real daemon database has no assignment for this closed reference.
			// VerifyDaemonCaller therefore produces the genuine local denial before
			// any ownership/cloud double can run; no kernel facts are fabricated.
			directory, err := os.MkdirTemp("/tmp", "bfb-rpc-fence.")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.RemoveAll(directory) })
			paths, err := daemon.StatePaths(directory)
			if err != nil {
				t.Fatal(err)
			}
			server, err := daemon.Start(context.Background(), paths, registry)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(server.Close)
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			_, err = daemon.CallAgent(ctx, paths, "mcp.v2.bound_authority", map[string]any{"agent_bound_request": generated.AgentBoundLocalRequest{
				Correlation: f.input.Correlation, Request: generated.AgentBoundRequest{Reference: f.reference, Binding: *f.input.ExpectedBinding},
			}})
			if daemon.AsFailure(err).Code != "assignment_unknown" {
				t.Fatal("registered legacy handler did not reach local assignment denial", err)
			}
			if mode == "in_flight" {
				close(release)
				select {
				case err := <-finished:
					if daemon.AsFailure(err).Code != "offline_rejected" {
						t.Fatal("late result proof published after legacy local denial", err)
					}
				case <-ctx.Done():
					t.Fatal("late result confirmation did not join")
				}
			}
			if authority.currentGeneration() == generation {
				t.Fatal("legacy local denial did not fence result proof publication")
			}
			if _, found := authority.cached(key); found {
				t.Fatal("legacy local denial left a result proof cached")
			}
			authority.connection = f.service.connection
			f.cloud.confirmationErr = runner.ErrOffline
			if _, _, err := authority.confirm(ctx, f.reference, *f.input.ExpectedBinding, true); err == nil {
				t.Fatal("outage reused a result proof after known legacy local denial")
			}
		})
	}
}

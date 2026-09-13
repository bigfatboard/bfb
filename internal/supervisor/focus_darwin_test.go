// ABOUTME: Exercises focus authorization with a real controlling PTY, private store, process group and worktree lock.
// ABOUTME: Injects only app effects and signing while testing original-control fencing and one-way recovery.

package supervisor

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/protocol/generated"
)

func TestNativeFocusControls(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Second)
	defer cancel()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(ctx, "/usr/bin/script", "-q", "-F", filepath.Join(t.TempDir(), "synthetic-focus-pty.txt"), self, "-test.run=^TestNativeFocusFixture$", "-test.timeout=70s")
	command.Env = append(os.Environ(), "BFB_L05_FOCUS_FIXTURE=1")
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("native focus fixture failed: %v\n%s", err, output)
	}
}

func TestNativeFocusFixture(t *testing.T) {
	if os.Getenv("BFB_L05_FOCUS_FIXTURE") != "1" {
		t.Skip("subprocess-only controlling PTY fixture")
	}
	for _, outcome := range []string{"applied", "local_rejected", "delivery_unknown"} {
		t.Run(outcome, func(t *testing.T) {
			f := fixtureSignalRPC(t, "focus_existing")
			effects, acks := 0, 0
			claimRequest := f.connection.request
			f.connection.request = func(ctx context.Context, method, path string, data []byte) ([]byte, error) {
				switch path {
				case "controls/read":
					return json.Marshal(f.receipt)
				case "controls/claim":
					return claimRequest(ctx, method, path, data)
				case "controls/acknowledge":
					acks++
					var ack generated.RunControlDisposition
					if json.Unmarshal(data, &ack) != nil || ack.Disposition != outcome || ack.IdempotencyKey != f.command.ClaimKey {
						t.Fatal("focus acknowledgement changed identity or native result")
					}
					f.receipt.State, f.receipt.Disposition = "rejected", new(outcome)
					if outcome == "applied" {
						f.receipt.State = "applied"
					}
					return nil, failure("daemon_offline") // The canonical result committed; the reply was lost.
				}
				return nil, failure("invalid_request")
			}
			f.service.options.FocusTerminal = func(ctx context.Context, target generated.LocalExecutionFocus, check func(context.Context) error) error {
				effects++
				tty, err := controllingTTY(f.assignment.Supervisor.Process)
				if err != nil || target.TerminalIntentId != f.assignment.IntentID || target.Tty != tty || target.ControlId != f.command.ID || target.RunExecutionId != f.assignment.Claim.Assignment.RunExecutionId || target.AssignmentGeneration != f.assignment.Claim.Assignment.AssignmentGeneration {
					t.Fatal("focus retargeted the live controlling device", err)
				}
				before, err := f.store.control(ctx, f.command)
				if err != nil || before.State != "applying" || before.StartedAt != target.AuthorizedAt {
					t.Fatal("focus preceded durable one-way binding", err)
				}
				for range 4 {
					if err := check(ctx); err != nil {
						t.Fatal("live exact assignment rejected", err)
					}
				}
				if outcome == "delivery_unknown" {
					return failure("app_delivery_unknown")
				}
				if outcome == "local_rejected" {
					return failure("session_locked")
				}
				return nil
			}
			if err := f.service.processControl(context.Background(), f.store, f.command); err != nil {
				t.Fatal(err)
			}
			if f.claims.Load() != 1 || effects != 1 || acks != 0 {
				t.Fatal("focus did not have one separate local effect")
			}
			if err := f.service.processControl(context.Background(), f.store, f.command); err == nil {
				t.Fatal("lost acknowledgement was hidden")
			}
			if err := f.store.recoverControls(context.Background()); err != nil {
				t.Fatal(err)
			}
			for range 2 {
				if err := f.service.processControl(context.Background(), f.store, f.command); err != nil {
					t.Fatal(err)
				}
			}
			if f.claims.Load() != 1 || effects != 1 || acks != 1 {
				t.Fatal("recovery replayed a focus effect")
			}
			command, _ := f.store.Command(context.Background(), f.command.RunnerID, f.command.ID)
			if command.State != "complete" {
				t.Fatal("canonical focus acknowledgement was lost")
			}
		})
	}
	for _, fault := range []string{"revoked", "slow_claim", "backwards_claim", "end_after_claim", "release_after_claim", "before_effect_expired", "before_effect_ended", "before_effect_unknown", "before_effect_control_closed", "app_reply_lost"} {
		t.Run(fault, func(t *testing.T) {
			f := fixtureSignalRPC(t, "focus_existing")
			effects := 0
			claimRequest := f.connection.request
			f.connection.request = func(ctx context.Context, method, path string, data []byte) ([]byte, error) {
				if path == "controls/read" {
					return json.Marshal(f.receipt)
				}
				if path != "controls/claim" {
					t.Fatal("unexpected focus replay", path)
				}
				result, err := claimRequest(ctx, method, path, data)
				switch fault {
				case "revoked":
					f.receipt.State, f.receipt.Disposition = "rejected", new("authorization_lost")
					return json.Marshal(f.receipt)
				case "slow_claim":
					f.clock.Add(int64(6 * time.Second))
				case "backwards_claim":
					f.clock.Add(-int64(time.Millisecond))
				case "end_after_claim":
					if _, err := f.store.db.Exec("UPDATE local_execution_assignments SET state = 'ended'"); err != nil {
						t.Fatal(err)
					}
				case "release_after_claim":
					if err := f.lock.Close(); err != nil {
						t.Fatal(err)
					}
				}
				return result, err
			}
			f.service.options.FocusTerminal = func(ctx context.Context, target generated.LocalExecutionFocus, check func(context.Context) error) error {
				switch fault {
				case "before_effect_expired":
					f.clock.Add(int64(6 * time.Second))
				case "before_effect_ended":
					if _, err := f.store.db.Exec("UPDATE local_execution_assignments SET state = 'ended'"); err != nil {
						t.Fatal(err)
					}
				case "before_effect_unknown":
					if _, err := f.store.rememberNative(ctx, f.assignment, nativeHistory{Uncertain: true}); err != nil {
						t.Fatal(err)
					}
				case "before_effect_control_closed":
					if _, err := f.store.db.Exec("UPDATE execution_commands SET state = 'complete' WHERE command_id = ?", f.command.ID); err != nil {
						t.Fatal(err)
					}
				case "app_reply_lost":
					if err := check(ctx); err != nil {
						t.Fatal(err)
					}
					effects++
					return failure("app_delivery_unknown")
				default:
					t.Fatal("invalid source or authorization reached the native app")
				}
				if err := check(ctx); err == nil {
					t.Fatal("stale native authority passed before UI effect")
				}
				return failure("expired_intent")
			}
			_ = f.service.processControl(context.Background(), f.store, f.command)
			if fault == "app_reply_lost" {
				current, _ := f.store.control(context.Background(), f.command)
				if effects != 1 || current.State != "delivery_unknown" {
					t.Fatal("lost app reply became success or a repeatable effect")
				}
			} else if effects != 0 {
				t.Fatal("invalid control performed focus")
			}
		})
	}
}

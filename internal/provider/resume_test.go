// ABOUTME: Certifies exact-session interactive resume plans and fail-closed capability boundaries.
// ABOUTME: Exercises only owned synthetic processes and keeps resume distinct from new sessions and turns.

package provider_test

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/fake"
)

func resumeInput(input provider.LaunchInput) provider.ResumeInput {
	input.Config.Mode = "interactive"
	input.Config.RequiredCapabilities = []string{"launch.interactive"}
	return provider.ResumeInput{LaunchInput: input, Session: provider.SessionBinding{
		Provider: "fake", ObservedID: "synthetic-session", RunID: "01J00000000000000000000002",
		ExecutionID: "01J00000000000000000000003", Generation: 1,
	}}
}

func TestResumeRequiresExactOwnedInteractiveBinding(t *testing.T) {
	registry, installation, launch, policy := fixture(t)
	probe := mustProbe(t, registry, installation)
	input := resumeInput(launch)
	for name, mutate := range map[string]func(*provider.ResumeInput){
		"headless":            func(v *provider.ResumeInput) { v.Config.Mode = "headless" },
		"requested_id":        func(v *provider.ResumeInput) { v.RequestedSessionID = "new-session" },
		"missing":             func(v *provider.ResumeInput) { v.Session = provider.SessionBinding{} },
		"provider":            func(v *provider.ResumeInput) { v.Session.Provider = "codex" },
		"session":             func(v *provider.ResumeInput) { v.Session.ObservedID = "" },
		"last_flag":           func(v *provider.ResumeInput) { v.Session.ObservedID = "--last" },
		"shell":               func(v *provider.ResumeInput) { v.Session.ObservedID = "x; touch CANARY" },
		"newline":             func(v *provider.ResumeInput) { v.Session.ObservedID = "x\n--last" },
		"nul":                 func(v *provider.ResumeInput) { v.Session.ObservedID = "x\x00" },
		"oversize":            func(v *provider.ResumeInput) { v.Session.ObservedID = strings.Repeat("x", 129) },
		"run":                 func(v *provider.ResumeInput) { v.Session.RunID = "from-peer" },
		"execution":           func(v *provider.ResumeInput) { v.Session.ExecutionID = "" },
		"zero_generation":     func(v *provider.ResumeInput) { v.Session.Generation = 0 },
		"negative_generation": func(v *provider.ResumeInput) { v.Session.Generation = -1 },
		"oversize_generation": func(v *provider.ResumeInput) { v.Session.Generation = 9007199254740992 },
	} {
		t.Run(name, func(t *testing.T) {
			altered := input
			mutate(&altered)
			_, err := registry.PlanResume(probe, altered, policy, time.Now())
			requireCode(t, err, "provider_session_invalid")
		})
	}
	plan, err := registry.PlanResume(probe, input, policy, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	invocation := plan.Invocation()
	if len(invocation.Stdin) != 0 || slices.Contains(invocation.Arguments, "--session") || slices.Contains(invocation.Arguments, "--fork") ||
		!slices.Equal(invocation.Arguments[len(invocation.Arguments)-2:], []string{"--resume", "synthetic-session"}) || plan.InitialState != "waiting_initial_turn" {
		t.Fatal("resume invented a new session, fork or turn")
	}
	input.Session.ObservedID = "changed"
	invocation.Arguments[len(invocation.Arguments)-1] = "tampered"
	if plan.Invocation().Arguments[len(invocation.Arguments)-1] != "synthetic-session" {
		t.Fatal("resume identity is mutable")
	}
	if err := registry.Revalidate(context.Background(), plan, time.Now()); err != nil {
		t.Fatal(err)
	}
	_, err = registry.PlanResume(probe, input, policy, probe.ExpiresAt)
	requireCode(t, err, "provider_probe_expired")
	if err := os.WriteFile(installation.ConfigFiles[0].Path, []byte(`{"changed":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	requireCode(t, registry.RevalidateSources(plan, time.Now()), "provider_changed")
}

type resumeCapabilityAdapter struct {
	fake.Adapter
	denied string
	calls  int
}

func (adapter *resumeCapabilityAdapter) Inspect(ctx context.Context, installation provider.Installation) (provider.RuntimeHealth, error) {
	health, err := adapter.Adapter.Inspect(ctx, installation)
	health.Capabilities = slices.DeleteFunc(health.Capabilities, func(value string) bool { return value == adapter.denied })
	return health, err
}

func (adapter *resumeCapabilityAdapter) Resume(input provider.ResumeInput) (provider.Invocation, error) {
	adapter.calls++
	return adapter.Adapter.Resume(input)
}

func TestResumeCannotInheritHeadlessOnlyOrDeniedCapabilities(t *testing.T) {
	for _, capability := range []string{"session.resume", "session.resume.interactive", "launch.interactive"} {
		for _, source := range []string{"manifest", "runtime", "policy"} {
			t.Run(capability+"/"+source, func(t *testing.T) {
				_, installation, launch, policy := fixture(t)
				descriptor := fake.Descriptor()
				adapter := &resumeCapabilityAdapter{}
				descriptor.Adapter = adapter
				remove := func(value string) bool { return value == capability }
				switch source {
				case "manifest":
					descriptor.Manifest.Capabilities = slices.DeleteFunc(descriptor.Manifest.Capabilities, remove)
				case "runtime":
					adapter.denied = capability
				case "policy":
					policy.AllowedCapabilities = slices.DeleteFunc(policy.AllowedCapabilities, remove)
				}
				registry, err := provider.NewRegistry([]provider.Descriptor{descriptor})
				if err != nil {
					t.Fatal(err)
				}
				probe := mustProbe(t, registry, installation)
				_, err = registry.PlanResume(probe, resumeInput(launch), policy, time.Now())
				requireCode(t, err, "provider_capability_denied")
				if adapter.calls != 0 {
					t.Fatal("denied resume reached the invocation builder")
				}
			})
		}
	}
}

func TestResumeSyntheticInteractiveProcessDoesNotFallBack(t *testing.T) {
	for _, transport := range []string{"none", "waiting_user_submit", "provider_prompt", "wrong_session"} {
		t.Run(transport, func(t *testing.T) {
			registry, installation, launch, policy := fixture(t)
			input := resumeInput(launch)
			input.Config.InitialTurnTransport = transport
			if transport == "wrong_session" {
				input.Config.InitialTurnTransport = "provider_prompt"
				input.Session.ObservedID = "unknown-session"
			}
			plan, err := registry.PlanResume(mustProbe(t, registry, installation), input, policy, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			invocation := plan.Invocation()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, invocation.Executable, invocation.Arguments...)
			command.Dir, command.Env = invocation.WorkingDirectory, invocation.Environment
			stdout, err := command.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = command.Process.Kill(); _ = command.Wait() })
			reader := bufio.NewReader(stdout)
			line, err := reader.ReadBytes('\n')
			if err != nil {
				t.Fatal(err)
			}
			var first provider.Candidate
			if err := json.Unmarshal(line, &first); err != nil {
				t.Fatal(err)
			}
			if transport == "wrong_session" {
				rest, err := io.ReadAll(reader)
				if err != nil || len(rest) != 0 || first.Kind != "provider_error" || first.SessionID != "" || command.Wait() == nil {
					t.Fatal("unknown resume silently created a session", err)
				}
				return
			}
			if first.Kind != "session_started" || first.SessionID != input.Session.ObservedID {
				t.Fatal("interactive resume selected another session")
			}
			if transport == "provider_prompt" {
				for _, kind := range []string{"turn_started", "turn_completed"} {
					line, err := reader.ReadBytes('\n')
					var event provider.Candidate
					if err != nil || json.Unmarshal(line, &event) != nil || event.Kind != kind || event.SessionID != input.Session.ObservedID {
						t.Fatal("fixed resumed prompt was not observed", err)
					}
				}
			}
			if err := command.Process.Signal(syscall.SIGTERM); err != nil {
				t.Fatal(err)
			}
			rest, err := io.ReadAll(reader)
			var last provider.Candidate
			if err != nil || json.Unmarshal(rest, &last) != nil || last.Kind != "interrupted" || command.Wait() != nil {
				t.Fatal("resume emitted an unrequested turn or did not stop", err)
			}
		})
	}
}

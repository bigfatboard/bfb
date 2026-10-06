// ABOUTME: Verifies the candidate-only registry keeps exact version, pin and real integration requirements.
// ABOUTME: Uses synthetic version-only executables and temporary configuration without live provider launches.

package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/claude"
)

func candidateFixture(t *testing.T) (candidateBinding, provider.Installation) {
	t.Helper()
	home := t.TempDir()
	binary := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nprintf '2.1.291 (Claude Code)\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("BFB_CLAUDE_HOME", home)
	t.Setenv("PATH", filepath.Dir(binary))
	launcher, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	settings, _, err := (claude.SettingsEditor{Launcher: launcher}).Prepare(nil)
	if err != nil {
		t.Fatal(err)
	}
	mcp, _, err := (claude.MCPServerEditor{Launcher: launcher}).Prepare(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(claude.SettingsPath(home)), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(claude.SettingsPath(home), settings, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(claude.MCPConfigPath(home), mcp, 0600); err != nil {
		t.Fatal(err)
	}
	stamp, err := provider.FingerprintExecutable(binary)
	if err != nil {
		t.Fatal(err)
	}
	installation, err := claude.Installation(home, launcher)
	if err != nil {
		t.Fatal(err)
	}
	return candidateBinding{SchemaVersion: 1, Version: candidateVersion, StateDirectory: "/tmp/bfb-l04-l07-Synthetic/state", Home: home, BinaryPath: stamp.CanonicalPath, BinaryHash: stamp.Hash, ProbeHash: provider.Hash([]byte("synthetic metadata"))}, installation
}

func TestCandidateRegistryDoesNotPromoteProduction(t *testing.T) {
	binding, installation := candidateFixture(t)
	candidate, err := candidateRegistry(binding)
	if err != nil {
		t.Fatal(err)
	}
	probe, err := candidate.Probe(context.Background(), "claude", installation, time.Now())
	if err != nil || probe.Status != "healthy" || !slices.Contains(probe.Capabilities, "mcp.stdio") {
		t.Fatal(probe, err)
	}
	production, err := provider.NewRegistry([]provider.Descriptor{claude.Descriptor()})
	if err != nil {
		t.Fatal(err)
	}
	closed, err := production.Probe(context.Background(), "claude", installation, time.Now())
	if err != nil || closed.Status != "unknown_version" || len(closed.Capabilities) != 0 || closed.ManifestID == probe.ManifestID {
		t.Fatal("candidate escaped production registry", closed, err)
	}
	if slices.Contains(claude.TestedVersions, candidateVersion) || slices.Contains(claude.Capabilities(), "mcp.stdio") || slices.Contains(claude.Capabilities(), "approval.never") || slices.Contains(claude.Capabilities(), "filesystem.full_access") {
		t.Fatal("mutated production descriptor")
	}
}

func TestCandidateAutonomyRequiresExplicitConfigurationAndLocalCeilings(t *testing.T) {
	binding, installation := candidateFixture(t)
	registry, err := candidateRegistry(binding)
	if err != nil {
		t.Fatal(err)
	}
	probe, err := registry.Probe(context.Background(), "claude", installation, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	input := provider.LaunchInput{WorkingDirectory: t.TempDir(), Config: generated.ExecutionConfig{
		Provider: "claude", Mode: "interactive", Model: "sonnet", Effort: "high",
		ApprovalPolicy: "on_request", FilesystemPolicy: "workspace_write",
		ContextInjection: "session_start_additional_context", InitialTurnTransport: "provider_prompt",
		RequiredCapabilities: []string{"hooks.session_start", "mcp.stdio"},
	}}
	policy := provider.Policy{AllowedCapabilities: slices.Clone(probe.Capabilities)}
	manual, err := registry.PlanLaunch(probe, input, policy, time.Now())
	if err != nil || slices.Contains(manual.Invocation().Arguments, "--dangerously-skip-permissions") || manual.SupervisionMode() != provider.RootSupervision {
		t.Fatal("manual candidate permission or supervision mismatch", err)
	}
	input.Config.ApprovalPolicy, input.Config.FilesystemPolicy = "never", "full_access"
	plan, err := registry.PlanLaunch(probe, input, policy, time.Now())
	if err != nil || plan.SupervisionMode() != provider.RootSupervision {
		t.Fatal("autonomous candidate supervision mismatch", err)
	}
	argv := plan.Invocation().Arguments
	if !slices.Contains(argv, "--dangerously-skip-permissions") || slices.Contains(argv, "--permission-mode") || slices.Contains(argv, "--allow-dangerously-skip-permissions") {
		t.Fatal("autonomous argv did not select explicit bypass", argv)
	}
	for _, capability := range autonomousCapabilities {
		ceiling := provider.Policy{AllowedCapabilities: slices.DeleteFunc(slices.Clone(policy.AllowedCapabilities), func(value string) bool { return value == capability })}
		if _, err := registry.PlanLaunch(probe, input, ceiling, time.Now()); err == nil {
			t.Fatal("missing local ceiling accepted", capability)
		}
	}
	resume := provider.ResumeInput{LaunchInput: input, Session: provider.SessionBinding{Provider: "claude", ObservedID: "33333333-3333-4333-8333-333333333333", RunID: "01J9Z8X1MNWT8YQ2R4S3V6K0P7", ExecutionID: "01J9Z8X1MNWT8YQ2R4S3V6K0Q9", Generation: 1}}
	continued, err := registry.PlanResume(probe, resume, policy, time.Now())
	if err != nil || continued.SupervisionMode() != provider.RootSupervision {
		t.Fatal("candidate resume supervision mismatch", err)
	}
	continuedArgs := continued.Invocation().Arguments
	if !slices.Contains(continuedArgs, "--dangerously-skip-permissions") || !slices.Contains(continuedArgs, resume.Session.ObservedID) || slices.Contains(continuedArgs, provider.InitialInstruction) || slices.Contains(continuedArgs, "--continue") || slices.Contains(continuedArgs, "--fork-session") {
		t.Fatal("autonomous resume changed exact session", continuedArgs)
	}
	input.Config.FilesystemPolicy, input.Config.ApprovalPolicy = "workspace_write", "on_request"
	input.Config.RequiredCapabilities[0] = "untrusted.changed"
	if !slices.Equal(plan.Invocation().Arguments, argv) {
		t.Fatal("caller mutation changed immutable plan")
	}
	for _, mutate := range []func(*provider.LaunchInput){
		func(value *provider.LaunchInput) { value.Config.ApprovalPolicy = "on_request" },
		func(value *provider.LaunchInput) { value.Config.FilesystemPolicy = "workspace_write" },
		func(value *provider.LaunchInput) { value.Config.Mode = "headless" },
	} {
		invalid := resume.LaunchInput
		invalid.Config.RequiredCapabilities = []string{"hooks.session_start", "mcp.stdio"}
		mutate(&invalid)
		if _, err := registry.PlanLaunch(probe, invalid, policy, time.Now()); err == nil {
			t.Fatal("permission mismatch was accepted", invalid.Config)
		}
	}
}

func TestCandidateRegistryRequiresCurrentIntegrationAndBinary(t *testing.T) {
	binding, installation := candidateFixture(t)
	registry, _ := candidateRegistry(binding)
	if err := os.WriteFile(claude.SettingsPath(binding.Home), []byte(`{"disableAllHooks":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	probe, err := registry.Probe(context.Background(), "claude", installation, time.Now())
	if err != nil || slices.Contains(probe.Capabilities, "mcp.stdio") || slices.Contains(probe.Capabilities, "hooks.session_start") {
		t.Fatal("candidate bypassed real configuration", probe, err)
	}
	if err := os.WriteFile(binding.BinaryPath, []byte("#!/bin/sh\nprintf '2.1.291 (Claude Code)\\n'\n# replacement\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Probe(context.Background(), "claude", installation, time.Now()); err == nil {
		t.Fatal("candidate accepted a replaced pin")
	}
}

func TestCandidateRegistryRejectsOtherExactVersions(t *testing.T) {
	for _, version := range []string{"2.1.274", "2.1.275", "2.1.292"} {
		t.Run(version, func(t *testing.T) {
			binding, installation := candidateFixture(t)
			if err := os.WriteFile(binding.BinaryPath, []byte("#!/bin/sh\nprintf '"+version+" (Claude Code)\\n'\n"), 0700); err != nil {
				t.Fatal(err)
			}
			stamp, _ := provider.FingerprintExecutable(binding.BinaryPath)
			binding.BinaryHash = stamp.Hash
			registry, _ := candidateRegistry(binding)
			probe, err := registry.Probe(context.Background(), "claude", installation, time.Now())
			if err != nil || probe.Status != "unknown_version" || len(probe.Capabilities) != 0 {
				t.Fatal(probe, err)
			}
			input := provider.LaunchInput{WorkingDirectory: t.TempDir(), Config: generated.ExecutionConfig{
				Provider: "claude", Mode: "interactive", Model: "sonnet", Effort: "high",
				ApprovalPolicy: "never", FilesystemPolicy: "full_access",
				ContextInjection: "none", InitialTurnTransport: "none",
				RequiredCapabilities: []string{"launch.interactive"},
			}}
			if _, err := registry.PlanLaunch(probe, input, provider.Policy{AllowedCapabilities: autonomousCapabilities}, time.Now()); err == nil {
				t.Fatal("unsupported exact version produced a root or autonomous plan")
			}
		})
	}
}

func TestCandidateInstallationRejectsBeforeVersionExecution(t *testing.T) {
	for _, mode := range []string{"earlier_path_lookalike", "changed_pinned_file"} {
		t.Run(mode, func(t *testing.T) {
			binding, _ := candidateFixture(t)
			marker := filepath.Join(t.TempDir(), "version-executed")
			binary := binding.BinaryPath
			if mode == "earlier_path_lookalike" {
				binary = filepath.Join(t.TempDir(), "claude")
				t.Setenv("PATH", filepath.Dir(binary)+string(os.PathListSeparator)+os.Getenv("PATH"))
			}
			if err := os.WriteFile(binary, []byte("#!/bin/sh\nprintf observed > "+strconv.Quote(marker)+"\nprintf '2.1.291 (Claude Code)\\n'\n"), 0700); err != nil {
				t.Fatal(err)
			}
			resolver := candidateInstallation(binding)
			registry, _ := candidateRegistry(binding)
			installation, err := resolver(context.Background(), "claude")
			if err == nil {
				_, err = registry.Probe(context.Background(), "claude", installation, time.Now())
			}
			if err == nil {
				t.Fatal("unpinned version source was accepted")
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatal("unpinned --version executed", err)
			}
			for _, args := range [][]string{{"provider", "doctor", "claude"}, {"--json", "provider", "doctor", "claude"}, {"provider doctor claude"}} {
				fixed, err := fixedArguments(binding, args)
				if err != nil {
					t.Fatal(err)
				}
				if err := guardCandidateDoctor(context.Background(), fixed, resolver); err == nil {
					t.Fatal("doctor bypassed the pre-probe pin", args)
				}
				if _, err := os.Stat(marker); !os.IsNotExist(err) {
					t.Fatal("doctor executed unpinned --version", err)
				}
			}
		})
	}
}

func TestCandidateInstallationUsesRealOwnedSourcesAndCanonicalPin(t *testing.T) {
	binding, _ := candidateFixture(t)
	marker := filepath.Join(t.TempDir(), "version-executed")
	if err := os.WriteFile(binding.BinaryPath, []byte("#!/bin/sh\nprintf observed > "+strconv.Quote(marker)+"\nprintf '2.1.291 (Claude Code)\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	stamp, _ := provider.FingerprintExecutable(binding.BinaryPath)
	binding.BinaryHash = stamp.Hash
	resolver := candidateInstallation(binding)
	installation, err := resolver(context.Background(), "claude")
	if err != nil || installation.Executable != binding.BinaryPath || len(installation.ConfigFiles) != 2 {
		t.Fatal(installation, err)
	}
	registry, _ := candidateRegistry(binding)
	probe, err := registry.Probe(context.Background(), "claude", installation, time.Now())
	if err != nil || probe.Status != "healthy" || !slices.Contains(probe.Capabilities, "mcp.stdio") {
		t.Fatal(probe, err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("positive control never ran the exact pinned --version", err)
	}
	if _, err := resolver(context.Background(), "codex"); err == nil {
		t.Fatal("candidate resolved an unrelated provider")
	}
}

func TestCandidateDoctorGuardDoesNotRequirePathForOtherEntrypoints(t *testing.T) {
	binding, _ := candidateFixture(t)
	calls := 0
	unavailable := func(context.Context, string) (provider.Installation, error) {
		calls++
		return provider.Installation{}, provider.Failure("provider_unavailable")
	}
	for _, args := range [][]string{{"mcp", "stdio"}, {"hook", "ingest", "--provider", "claude"}, {"daemon", "status"}, {"daemon", "stop"}, {"provider", "setup", "claude"}} {
		fixed, _ := fixedArguments(binding, args)
		if err := guardCandidateDoctor(context.Background(), fixed, unavailable); err != nil {
			t.Fatal("non-doctor path acquired a PATH dependency", args, err)
		}
	}
	if calls != 0 {
		t.Fatal("non-doctor entrypoint attempted provider discovery")
	}
}

func TestCandidateBindingAndArgumentsStayPrivate(t *testing.T) {
	binding, _ := candidateFixture(t)
	raw, _ := json.Marshal(binding)
	decoded, err := decodeBinding(raw)
	if err != nil || decoded != binding {
		t.Fatal(decoded, err)
	}
	for _, args := range [][]string{{"hook", "ingest", "--provider", "claude"}, {"mcp", "stdio"}, {"__launch", "synthetic"}, {"__exec", "synthetic"}, {"--data-dir", binding.StateDirectory, "--json", "daemon", "status"}} {
		fixed, err := fixedArguments(binding, args)
		if err != nil || len(fixed) < 2 || fixed[0] != "--data-dir" || fixed[1] != binding.StateDirectory {
			t.Fatal(args, fixed, err)
		}
	}
	for _, args := range [][]string{{"--data-dir", "/tmp/unrelated", "daemon", "run"}, {"hook", "--data-dir", binding.StateDirectory}, {"--data-dir=" + binding.StateDirectory, "daemon", "run"}, {"daemon", "install"}, {"--json", "daemon", "install", "--label", "com.example.test"}, {"--", "daemon", "install"}, {"daemon install"}} {
		if _, err := fixedArguments(binding, args); err == nil {
			t.Fatal("candidate accepted override or installation", args)
		}
	}
	for _, mutate := range []func(*candidateBinding){func(b *candidateBinding) { b.Version = "2.1.292" }, func(b *candidateBinding) { b.StateDirectory = "/tmp/unrelated/state" }, func(b *candidateBinding) { b.Home = "relative" }, func(b *candidateBinding) { b.BinaryHash = "unbound" }} {
		bad := binding
		mutate(&bad)
		raw, _ := json.Marshal(bad)
		if _, err := decodeBinding(raw); err == nil {
			t.Fatal("candidate accepted invalid binding")
		}
	}
	if _, err := decodeBinding(append(raw, []byte(` {}`)...)); err == nil {
		t.Fatal("accepted trailing resource data")
	}
}

func TestCandidateBundleResolvesSystemDirectoryAliases(t *testing.T) {
	directory := t.TempDir()
	app := filepath.Join(directory, "BFB.app")
	helper := filepath.Join(app, "Contents", "Helpers", "bfb")
	if err := os.MkdirAll(filepath.Dir(helper), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(helper, []byte("synthetic helper, never executed"), 0700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "build-directory")
	if err := os.Symlink(directory, alias); err != nil {
		t.Fatal(err)
	}
	canonical, err := filepath.EvalSymlinks(app)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{helper, filepath.Join(alias, "BFB.app", "Contents", "Helpers", "bfb")} {
		resolved, err := candidateBundle(path)
		if err != nil || resolved != canonical {
			t.Fatal("private /tmp or /var alias lost its signed bundle", resolved, err)
		}
	}
	wrong := filepath.Join(directory, "bfb")
	if err := os.WriteFile(wrong, []byte("synthetic loose helper"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := candidateBundle(wrong); err == nil {
		t.Fatal("loose helper accepted as a signed candidate bundle")
	}
}

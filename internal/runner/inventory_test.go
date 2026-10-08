// ABOUTME: Verifies runner discovery uses the setup-published provider installation and capabilities.
// ABOUTME: Uses a version-only Claude stub and isolated owned configuration without live providers.

package runner

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/checkout"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers"
	"github.com/qdis/bfb/internal/providers/claude"
)

func requireInventoryWire(t *testing.T, raw []byte) {
	t.Helper()
	if decoded := protocol.DecodeWireDocument("runner-inventory", raw); !decoded.OK {
		path := ""
		if decoded.Error.Path != nil {
			path = *decoded.Error.Path
		}
		t.Fatalf("inventory is not valid on the upload wire at %s: %s/%s", path, decoded.Error.Category, decoded.Error.Code)
	}
}

func TestInventoryTimestampFloorsTranslatedClock(t *testing.T) {
	for _, test := range []struct {
		name, observed, want string
		offset               time.Duration
	}{
		{"fraction", "2026-10-06T07:48:12.123456789Z", "2026-10-06T07:48:12.123456Z", 0},
		{"positive carry", "2026-10-06T07:48:12.123456789Z", "2026-10-06T07:48:12.123457Z", 211 * time.Nanosecond},
		{"negative borrow", "2026-10-06T07:48:12.123456789Z", "2026-10-06T07:48:12.123455Z", -790 * time.Nanosecond},
		{"positive hour", "2026-10-06T07:48:12.123456789Z", "2026-10-06T08:48:12.123457Z", time.Hour + 999*time.Nanosecond},
		{"negative hour", "2026-10-06T07:48:12.123456789Z", "2026-10-06T06:48:12.123456Z", -time.Hour - 789*time.Nanosecond},
		{"second boundary", "2026-10-06T07:48:12.000000111Z", "2026-10-06T07:48:11.999999Z", -112 * time.Nanosecond},
		{"UTC conversion", "2026-10-06T10:48:12.123456789+03:00", "2026-10-06T07:48:12.123456Z", 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			observed, err := time.Parse(time.RFC3339Nano, test.observed)
			if err != nil {
				t.Fatal(err)
			}
			got := inventoryTimestamp(observed, test.offset)
			if got != test.want {
				t.Fatalf("got %s, want %s", got, test.want)
			}
			translated, err := time.Parse(time.RFC3339Nano, got)
			if err != nil {
				t.Fatal(err)
			}
			discarded := observed.Add(test.offset).Sub(translated)
			if discarded < 0 || discarded >= time.Microsecond {
				t.Fatal("timestamp did not floor the translated observation", discarded)
			}
			expires, err := time.Parse(time.RFC3339Nano, inventoryTimestamp(observed.Add(30*time.Second), test.offset))
			if err != nil || expires.Sub(translated) != 30*time.Second {
				t.Fatal("timestamp conversion extended probe lifetime", err)
			}
		})
	}
}

func TestLocalInventoryWireTimestampsWithClockOffsets(t *testing.T) {
	store, _ := runnerStore(t)
	enrollment, _ := savedEnrollment(t, store)
	root := t.TempDir()
	for _, args := range [][]string{{"init", "--initial-branch=main"}, {"remote", "add", "origin", "https://github.com/qdis/bfb.git"}} {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		command := exec.CommandContext(ctx, "/usr/bin/git", args...)
		command.Dir = root
		command.Env = []string{"PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null"}
		output, err := command.CombinedOutput()
		cancel()
		if err != nil {
			t.Fatalf("initialize synthetic checkout: %v: %s", err, output)
		}
	}
	const projectID = "01JBFB0PR0JECTX00000000000"
	local := checkout.NewRegistry(store.db)
	record, err := local.Link(context.Background(), checkout.LinkInput{
		WorkspaceID: enrollment.WorkspaceID, RunnerID: enrollment.RunnerID, ProjectID: projectID,
		Path: root, RepositoryIdentity: "github.com/qdis/bfb", WorkspaceSubpath: ".", Label: "Synthetic checkout",
	})
	if err != nil {
		t.Fatal(err)
	}
	registry, err := provider.NewRegistry([]provider.Descriptor{claude.Descriptor()})
	if err != nil {
		t.Fatal(err)
	}
	source := LocalInventoryWithProviders(store.db, registry, func(context.Context, string) (provider.Installation, error) {
		return provider.Installation{}, provider.Failure("provider_unavailable")
	})
	for _, offset := range []time.Duration{0, time.Nanosecond, -time.Nanosecond, 999 * time.Nanosecond, -999 * time.Nanosecond, time.Hour + 497*time.Nanosecond, -time.Hour - 497*time.Nanosecond} {
		t.Run(offset.String(), func(t *testing.T) {
			before := time.Now().Add(offset).UTC().Truncate(time.Microsecond)
			raw, err := source(context.Background(), enrollment, []string{projectID}, offset)
			after := time.Now().Add(offset).UTC().Truncate(time.Microsecond)
			if err != nil {
				t.Fatal(err)
			}
			requireInventoryWire(t, raw)
			var inventory struct {
				Checkouts []generated.CheckoutSummary `json:"checkouts"`
				Providers []providerReport            `json:"providers"`
			}
			if err := json.Unmarshal(raw, &inventory); err != nil {
				t.Fatal(err)
			}
			if len(inventory.Checkouts) != 1 || inventory.Checkouts[0].CheckoutId != record.Summary.CheckoutId || len(inventory.Providers) != 1 {
				t.Fatal("inventory omitted checkout or unavailable provider")
			}
			page, _, err := local.List(context.Background(), checkout.ListOptions{WorkspaceID: enrollment.WorkspaceID, RunnerID: enrollment.RunnerID, Limit: 25})
			if err != nil || len(page) != 1 {
				t.Fatalf("read original checkout observation: %v", err)
			}
			observed, err := time.Parse(time.RFC3339Nano, page[0].ValidatedAt)
			if err != nil {
				t.Fatal(err)
			}
			want := observed.Add(offset).UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano)
			if inventory.Checkouts[0].ValidatedAt != want {
				t.Fatalf("checkout clock translated incorrectly: got %s, want %s", inventory.Checkouts[0].ValidatedAt, want)
			}
			report := inventory.Providers[0]
			observed, err = time.Parse(time.RFC3339Nano, report.ObservedAt)
			if err != nil {
				t.Fatal(err)
			}
			expires, err := time.Parse(time.RFC3339Nano, report.ExpiresAt)
			if err != nil {
				t.Fatal(err)
			}
			if report.Status != "unavailable" || len(report.Capabilities) != 0 || observed.Before(before) || observed.After(after) || expires.Sub(observed) != 30*time.Second {
				t.Fatal("unavailable observation changed clock or probe lifetime", report)
			}
			if strings.Contains(string(raw), root) {
				t.Fatal("inventory leaked the checkout path")
			}
		})
	}
}

func TestLocalInventoryUsesClaudeOwnedInstallation(t *testing.T) {
	store, _ := runnerStore(t)
	enrollment, _ := savedEnrollment(t, store)
	home, bin := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte("#!/bin/sh\n[ -z \"${ANTHROPIC_API_KEY-}\" ] || exit 1\n[ -z \"${CLAUDE_CONFIG_DIR-}\" ] || exit 1\n[ -f \"$HOME/.claude/settings.json\" ] || exit 1\n[ -f \"$HOME/.claude.json\" ] || exit 1\nprintf '2.1.275 (Claude Code)\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	t.Setenv("BFB_CLAUDE_HOME", home)
	t.Setenv("HOME", home)
	t.Setenv("ANTHROPIC_API_KEY", "synthetic-forbidden-canary")
	t.Setenv("CLAUDE_CONFIG_DIR", "synthetic-forbidden-override")
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
	registry, err := provider.NewRegistry([]provider.Descriptor{claude.Descriptor()})
	if err != nil {
		t.Fatal(err)
	}
	source := LocalInventory(store.db)
	for _, configured := range []bool{true, false} {
		if !configured {
			var value map[string]any
			_ = json.Unmarshal(settings, &value)
			value["disableAllHooks"] = true
			settings, _ = json.Marshal(value)
			if err := os.WriteFile(claude.SettingsPath(home), settings, 0600); err != nil {
				t.Fatal(err)
			}
		}
		raw, err := source(context.Background(), enrollment, nil, 497*time.Nanosecond)
		if err != nil {
			t.Fatal(err)
		}
		requireInventoryWire(t, raw)
		var inventory struct{ Providers []providerReport }
		if err := json.Unmarshal(raw, &inventory); err != nil {
			t.Fatal(err)
		}
		found := false
		for _, report := range inventory.Providers {
			if report.Provider != "claude" {
				continue
			}
			found = true
			if report.Status != "healthy" || report.Version != "2.1.275" || report.ManifestID == "" {
				t.Fatalf("unexpected owned Claude inventory: %+v", report)
			}
			for _, capability := range []string{"hooks.session_start", "context.session_start"} {
				if slices.Contains(report.Capabilities, capability) != configured {
					t.Fatalf("%s granted without exact current configuration", capability)
				}
			}
			observed, _ := time.Parse(time.RFC3339Nano, report.ObservedAt)
			expires, _ := time.Parse(time.RFC3339Nano, report.ExpiresAt)
			if expires.Sub(observed) != 30*time.Second {
				t.Fatal("inventory widened probe freshness")
			}
			installation, err := providers.LocalInstallation(context.Background(), "claude")
			if err != nil {
				t.Fatal(err)
			}
			probe, err := registry.Probe(context.Background(), "claude", installation, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			wantCapabilities := slices.DeleteFunc(slices.Clone(probe.Capabilities), func(capability string) bool {
				return capability == "session.resume.interactive"
			})
			if !slices.Contains(probe.Capabilities, "session.resume.interactive") || !slices.Contains(report.Capabilities, "session.resume") || !slices.Equal(report.Capabilities, wantCapabilities) {
				t.Fatal("wire projection changed local resume or other capabilities", report.Capabilities, probe.Capabilities)
			}
			plan, err := registry.PlanResume(probe, provider.ResumeInput{
				LaunchInput: provider.LaunchInput{WorkingDirectory: home, Config: generated.ExecutionConfig{
					Provider: "claude", Mode: "interactive", Model: "sonnet", Effort: "low",
					ApprovalPolicy: "on_request", FilesystemPolicy: "workspace_write",
					ContextInjection: "none", InitialTurnTransport: "none", RequiredCapabilities: []string{"session.resume"},
				}},
				Session: provider.SessionBinding{Provider: "claude", ObservedID: "22222222-2222-4222-8222-222222222222", RunID: "01JBFB0RVN1D00000000000000", ExecutionID: "01JBFB0EXECVT10N0000000000", Generation: 1},
			}, provider.Policy{AllowedCapabilities: probe.Capabilities}, time.Now())
			if err != nil || !slices.Contains(plan.Invocation().Arguments, "--resume") {
				t.Fatal("inventory projection changed the local interactive resume plan", err)
			}
		}
		if !found || strings.Contains(string(raw), home) || strings.Contains(string(raw), "synthetic-forbidden") {
			t.Fatal("provider observation missing or private installation leaked")
		}
	}
}

func TestManagerInventoryConsumesOnlyItsCompiledProviderRegistry(t *testing.T) {
	store, paths := runnerStore(t)
	// There are no enrollments: starting this local manager cannot contact a
	// control plane or create a credential. Inventory still uses real discovery.
	descriptor := claude.Descriptor()
	descriptor.Manifest.Version = "0.0.1"
	descriptor.Manifest.TestedVersions = []string{"2.1.291"}
	registry, err := provider.NewRegistry([]provider.Descriptor{descriptor})
	if err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte("#!/bin/sh\nprintf '2.1.291 (Claude Code)\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("BFB_CLAUDE_HOME", home)
	t.Setenv("PATH", bin)
	manager := NewManager(ManagerOptions{Providers: registry})
	closeManager, err := manager.Start(context.Background(), &daemon.Store{DB: store.db, Paths: paths})
	if err != nil {
		t.Fatal(err)
	}
	defer closeManager()
	enrollment, _ := savedEnrollment(t, store)
	raw, err := manager.inventory(context.Background(), enrollment, nil, -497*time.Nanosecond)
	if err != nil {
		t.Fatal(err)
	}
	requireInventoryWire(t, raw)
	var inventory struct{ Providers []providerReport }
	if err := json.Unmarshal(raw, &inventory); err != nil {
		t.Fatal(err)
	}
	if len(inventory.Providers) != 1 || inventory.Providers[0].Provider != "claude" || inventory.Providers[0].Version != "2.1.291" || inventory.Providers[0].Status != "healthy" || slices.Contains(inventory.Providers[0].Capabilities, "mcp.stdio") {
		t.Fatal("inventory did not use the compiled real adapter", inventory)
	}
	if slices.Contains(claude.TestedVersions, "2.1.291") {
		t.Fatal("injected registry mutated production versions")
	}
	raw, err = LocalInventory(store.db)(context.Background(), enrollment, nil, 999*time.Nanosecond)
	if err != nil {
		t.Fatal(err)
	}
	requireInventoryWire(t, raw)
	if err := json.Unmarshal(raw, &inventory); err != nil {
		t.Fatal(err)
	}
	for _, report := range inventory.Providers {
		if report.Provider == "claude" && (report.Status != "unknown_version" || len(report.Capabilities) != 0) {
			t.Fatal("normal inventory accepted candidate version", report)
		}
	}
}

func TestManagerInventoryRejectsInstallationBeforeVersionProbe(t *testing.T) {
	store, paths := runnerStore(t)
	descriptor := claude.Descriptor()
	descriptor.Manifest.TestedVersions = []string{"2.1.291"}
	registry, err := provider.NewRegistry([]provider.Descriptor{descriptor})
	if err != nil {
		t.Fatal(err)
	}
	bin, home := t.TempDir(), t.TempDir()
	marker := filepath.Join(bin, "version-executed")
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte("#!/bin/sh\nprintf observed > "+strconv.Quote(marker)+"\nprintf '2.1.291 (Claude Code)\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	t.Setenv("HOME", home)
	t.Setenv("BFB_CLAUDE_HOME", home)
	calls := 0
	manager := NewManager(ManagerOptions{Providers: registry, Installation: func(ctx context.Context, name string) (provider.Installation, error) {
		calls++
		if _, err := providers.LocalInstallation(ctx, name); err != nil {
			return provider.Installation{}, err
		}
		return provider.Installation{}, provider.Failure("provider_changed")
	}})
	closeManager, err := manager.Start(context.Background(), &daemon.Store{DB: store.db, Paths: paths})
	if err != nil {
		t.Fatal(err)
	}
	defer closeManager()
	enrollment, _ := savedEnrollment(t, store)
	raw, err := manager.inventory(context.Background(), enrollment, nil, -999*time.Nanosecond)
	if err != nil {
		t.Fatal(err)
	}
	requireInventoryWire(t, raw)
	var inventory struct{ Providers []providerReport }
	if err := json.Unmarshal(raw, &inventory); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || len(inventory.Providers) != 1 || inventory.Providers[0].Status != "unavailable" || len(inventory.Providers[0].Capabilities) != 0 || inventory.Providers[0].Version != "" {
		t.Fatal("inventory bypassed installation rejection", inventory, calls)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("rejected inventory executed --version", err)
	}
}

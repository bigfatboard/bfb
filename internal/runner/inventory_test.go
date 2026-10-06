// ABOUTME: Verifies runner discovery uses the setup-published provider installation and capabilities.
// ABOUTME: Uses a version-only Claude stub and isolated owned configuration without live providers.

package runner

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers"
	"github.com/qdis/bfb/internal/providers/claude"
)

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
		raw, err := source(context.Background(), enrollment, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
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
	raw, err := manager.inventory(context.Background(), enrollment, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
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
	raw, err = LocalInventory(store.db)(context.Background(), enrollment, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
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
	raw, err := manager.inventory(context.Background(), enrollment, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
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

// ABOUTME: Verifies runner discovery uses the setup-published provider installation and capabilities.
// ABOUTME: Uses a version-only Claude stub and isolated owned configuration without live providers.

package runner

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

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

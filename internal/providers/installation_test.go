// ABOUTME: Verifies provider-owned environment filtering survives local helper reconstruction.
// ABOUTME: Checks credential canaries and preserves non-Claude environment behavior.

package providers

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/providers/claude"
)

func TestExecutionEnvironmentPreservesClaudeBoundary(t *testing.T) {
	ambient := []string{"HOME=/synthetic-home", "PATH=/usr/bin:/bin", "PATH=/wrong-path", "TERM=xterm", "ANTHROPIC_API_KEY=synthetic-key", "CLAUDE_CODE_OAUTH_TOKEN=synthetic-token", "CLAUDE_CONFIG_DIR=/wrong-home", "LOCAL_CREDENTIAL=synthetic-credential", "BFB_TASK_ID=wrong", "BFB_CLAUDE_HOME=/test-only-home"}
	want := []string{"HOME=/synthetic-home", "PATH=/usr/bin:/bin", "TERM=xterm"}
	if got := ExecutionEnvironment("claude", ambient); !reflect.DeepEqual(got, want) {
		t.Fatal("Claude environment admits credentials or behavioral overrides")
	}
	if len(ambient) != 10 {
		t.Fatal("ambient environment mutated")
	}
	if got := ExecutionEnvironment("codex", []string{"LOCAL_CREDENTIAL=synthetic", "CODEX_HOME=/synthetic-codex", "BFB_TASK_ID=wrong"}); !reflect.DeepEqual(got, []string{"LOCAL_CREDENTIAL=synthetic", "CODEX_HOME=/synthetic-codex"}) {
		t.Fatal("unrelated provider environment policy changed")
	}
}

func TestLocalClaudeInstallationRequiresExecutionHome(t *testing.T) {
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	for _, fault := range []string{"default", "matching_override", "different_override", "missing_home", "relative_home"} {
		t.Run(fault, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("BFB_CLAUDE_HOME", "")
			switch fault {
			case "matching_override":
				t.Setenv("BFB_CLAUDE_HOME", home)
			case "different_override":
				t.Setenv("BFB_CLAUDE_HOME", t.TempDir())
			case "missing_home":
				t.Setenv("HOME", "")
				t.Setenv("BFB_CLAUDE_HOME", home)
			case "relative_home":
				t.Setenv("HOME", "relative-home")
				t.Setenv("BFB_CLAUDE_HOME", home)
			}
			installation, err := LocalInstallation(context.Background(), "claude")
			if fault != "default" && fault != "matching_override" {
				if err == nil || daemon.AsFailure(err).Diagnostic().Code != "provider_path_unsafe" {
					t.Fatalf("mismatched execution home accepted: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Contains(installation.Environment, "HOME="+home) || len(installation.ConfigFiles) != 2 || installation.ConfigFiles[0].Path != claude.SettingsPath(home) || installation.ConfigFiles[1].Path != claude.MCPConfigPath(home) {
				t.Fatal("installation config sources differ from provider execution home")
			}
		})
	}
}

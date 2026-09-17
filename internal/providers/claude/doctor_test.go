// ABOUTME: Certifies Claude doctor diagnostics for every listed failure mode.
// ABOUTME: Uses stub binaries and isolated homes; never touches real config.

package claude_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/qdis/bfb/internal/providers/claude"
)

func diagnose(t *testing.T, home, launcher, version string) claude.Report {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\necho \""+version+" (Claude Code)\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	return claude.Diagnose(home, launcher, binary)
}

func checkStatus(t *testing.T, report claude.Report, name string) claude.CheckStatus {
	t.Helper()
	for _, check := range report.Checks {
		if check.Name == name {
			return check.Status
		}
	}
	t.Fatalf("missing check %s in %+v", name, report.Checks)
	return ""
}

func TestDiagnoseHealthy(t *testing.T) {
	home, launcher := testHome(t)
	applyProposal(t, filepath.Join(home, ".claude", "settings.json"), claude.SettingsEditor{Launcher: launcher}, okDoctor)
	applyProposal(t, filepath.Join(home, ".claude.json"), claude.MCPServerEditor{Launcher: launcher}, okDoctor)
	for _, version := range []string{"2.1.274", "2.1.275"} {
		report := diagnose(t, home, launcher, version)
		if report.Version != version {
			t.Fatalf("unexpected version %s", report.Version)
		}
		diagnoseHealthy(t, report)
	}
}

func diagnoseHealthy(t *testing.T, report claude.Report) {
	t.Helper()
	for _, name := range []string{"binary", "version", "hooks_enabled", "hooks", "mcp", "launcher", "integration"} {
		if status := checkStatus(t, report, name); status != claude.CheckPassed {
			t.Fatalf("%s: %s", name, status)
		}
	}
	// The startup probe runs but must never certify before A01.
	unverified := 0
	for _, check := range report.Checks {
		if check.Status == claude.CheckUnverified {
			unverified++
			if check.Code != "mcp_startup_unverified" {
				t.Fatalf("unexpected unverified check %+v", check)
			}
		}
	}
	if unverified != 1 {
		t.Fatalf("want exactly the MCP startup check unverified, got %+v", report.Checks)
	}
	if report.Failed() {
		t.Fatal("healthy integration reports failure")
	}
}

func TestDiagnoseFailures(t *testing.T) {
	cases := []struct {
		name  string
		setup func(home, launcher string)
		check string
		code  string
	}{
		{name: "missing hooks", setup: func(home, launcher string) {}, check: "hooks", code: "hooks_missing"},
		{name: "unknown version", setup: func(home, launcher string) {
			applyProposal(t, filepath.Join(home, ".claude", "settings.json"), claude.SettingsEditor{Launcher: launcher}, okDoctor)
		}, check: "version", code: "unknown_version"},
		{name: "duplicate hooks", setup: func(home, launcher string) {
			raw := `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"` + launcher + `","args":["hook","ingest","--provider","claude"]},{"type":"command","command":"` + launcher + `","args":["hook","ingest","--provider","claude"]}]}]}}`
			if err := os.WriteFile(filepath.Join(home, ".claude", "settings.json"), []byte(raw), 0600); err != nil {
				t.Fatal(err)
			}
		}, check: "hooks", code: "duplicate_hooks"},
		{name: "drifted launcher", setup: func(home, launcher string) {
			stale := filepath.Join(t.TempDir(), "old-bfb")
			if err := os.WriteFile(stale, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
				t.Fatal(err)
			}
			editor := claude.SettingsEditor{Launcher: stale}
			after, _, err := editor.Prepare(nil)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(home, ".claude", "settings.json"), after, 0600); err != nil {
				t.Fatal(err)
			}
		}, check: "hooks", code: "hooks_drift"},
		{name: "hooks disabled", setup: func(home, launcher string) {
			applyProposal(t, filepath.Join(home, ".claude", "settings.json"), claude.SettingsEditor{Launcher: launcher}, okDoctor)
			raw := readFile(t, filepath.Join(home, ".claude", "settings.json"))
			if err := os.WriteFile(filepath.Join(home, ".claude", "settings.json"), append([]byte(`{"disableAllHooks":true,`), raw[1:]...), 0600); err != nil {
				t.Fatal(err)
			}
		}, check: "hooks_enabled", code: "hooks_disabled"},
		{name: "garbage settings", setup: func(home, launcher string) {
			if err := os.WriteFile(filepath.Join(home, ".claude", "settings.json"), []byte("{nope"), 0600); err != nil {
				t.Fatal(err)
			}
		}, check: "hooks", code: "provider_config_invalid"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home, launcher := testHome(t)
			tc.setup(home, launcher)
			version := "2.1.274"
			if tc.check == "version" {
				version = "9.9.9"
			}
			report := diagnose(t, home, launcher, version)
			found := false
			for _, check := range report.Checks {
				if check.Name == tc.check && check.Status == claude.CheckFailed && check.Code == tc.code {
					found = true
				}
			}
			if !found {
				t.Fatalf("missing %s/%s in %+v", tc.check, tc.code, report.Checks)
			}
			if !report.Failed() {
				t.Fatal("broken integration reports success")
			}
		})
	}
}

func TestDiagnoseMissingBinary(t *testing.T) {
	home, launcher := testHome(t)
	report := claude.Diagnose(home, launcher, filepath.Join(t.TempDir(), "absent-claude"))
	if !report.Failed() {
		t.Fatal("missing binary reports success")
	}
	if status := checkStatus(t, report, "binary"); status != claude.CheckFailed {
		t.Fatalf("binary: %s", status)
	}
}

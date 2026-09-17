// ABOUTME: Certifies BFB-owned Claude config edits preserve unowned semantics.
// ABOUTME: Proves approval binding, concurrent-edit conflict, and rollback.

package claude_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/claude"
)

func testHome(t *testing.T) (home, launcher string) {
	t.Helper()
	home = t.TempDir()
	launcher = filepath.Join(t.TempDir(), "bfb")
	if err := os.WriteFile(launcher, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0700); err != nil {
		t.Fatal(err)
	}
	return home, launcher
}

func stubForTest(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(path, []byte("#!/bin/sh\necho \"2.1.274 (Claude Code)\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	return path
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func okDoctor(context.Context) error { return nil }

func TestSettingsEditorPreservesUnowned(t *testing.T) {
	home, launcher := testHome(t)
	before := `{"model":"opus","permissions":{"allow":["Read"]},"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"/bin/echo","args":["hi"]}]}],"SessionStart":[{"matcher":"startup","hooks":[{"type":"command","command":"/bin/echo","args":["mine"]}]}]},"mcpServers":{"other":{"type":"stdio","command":"/bin/true"}}}`
	settings := filepath.Join(home, ".claude", "settings.json")
	if err := os.WriteFile(settings, []byte(before), 0600); err != nil {
		t.Fatal(err)
	}
	editor := claude.SettingsEditor{Launcher: launcher}
	unownedBefore, err := editor.UnownedSemantics([]byte(before))
	if err != nil {
		t.Fatal(err)
	}
	after, diff, err := editor.Prepare([]byte(before))
	if err != nil {
		t.Fatal(err)
	}
	unownedAfter, err := editor.UnownedSemantics(after)
	if err != nil {
		t.Fatal(err)
	}
	if string(unownedBefore) != string(unownedAfter) {
		t.Fatalf("unowned semantics changed:\n%s\n%s", unownedBefore, unownedAfter)
	}
	for _, want := range []string{`"model"`, `"permissions"`, `/bin/echo`, `"mcpServers"`, launcher} {
		if !strings.Contains(string(after), want) {
			t.Fatalf("missing %s in %s", want, after)
		}
	}
	if diff.Namespace != "bfb.hooks" {
		t.Fatalf("unexpected namespace %s", diff.Namespace)
	}
	// Idempotency: a second prepare changes nothing.
	again, _, err := editor.Prepare(after)
	if err != nil {
		t.Fatal(err)
	}
	if string(again) != string(after) {
		t.Fatalf("prepare not idempotent:\n%s\n%s", after, again)
	}
}

func TestSettingsEditorNoOpKeepsBytes(t *testing.T) {
	home, launcher := testHome(t)
	settings := filepath.Join(home, ".claude", "settings.json")
	editor := claude.SettingsEditor{Launcher: launcher}
	after, _, err := editor.Prepare(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settings, after, 0600); err != nil {
		t.Fatal(err)
	}
	stable, _, err := editor.Prepare(readFile(t, settings))
	if err != nil {
		t.Fatal(err)
	}
	if string(stable) != string(after) {
		t.Fatal("already-current settings were rewritten")
	}
}

func TestSettingsEditorDedupsAndRepairs(t *testing.T) {
	home, launcher := testHome(t)
	settings := filepath.Join(home, ".claude", "settings.json")
	stale := `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/old/bfb","args":["hook","ingest","--provider","claude"]},{"type":"command","command":"/old/bfb","args":["hook","ingest","--provider","claude"]}]}]}}`
	if err := os.WriteFile(settings, []byte(stale), 0600); err != nil {
		t.Fatal(err)
	}
	editor := claude.SettingsEditor{Launcher: launcher}
	after, _, err := editor.Prepare([]byte(stale))
	if err != nil {
		t.Fatal(err)
	}
	if count := strings.Count(string(after), `"hook",`); count != 7 {
		t.Fatalf("want one BFB handler per subscribed event, got %d in %s", count, after)
	}
	if strings.Contains(string(after), "/old/bfb") {
		t.Fatalf("stale launcher survived: %s", after)
	}
	owned, err := editor.UnownedSemantics(after)
	if err != nil {
		t.Fatal(err)
	}
	if string(owned) != "{}" {
		t.Fatalf("unexpected unowned residue %s", owned)
	}
}

func TestSettingsEditorRejectsAmbiguous(t *testing.T) {
	editor := claude.SettingsEditor{Launcher: "/bin/bfb"}
	for _, raw := range []string{
		`{invalid}`,
		`[1,2]`,
		`"text"`,
		`{"hooks":[1]}`,
		`{"hooks":{"Stop":"soon"}}`,
		`{"hooks":{"Stop":[42]}}`,
		`{"hooks":{"Stop":[{"hooks":"soon"}]}}`,
	} {
		if _, _, err := editor.Prepare([]byte(raw)); daemon.AsFailure(err).Diagnostic().Code != "provider_config_invalid" {
			t.Fatalf("%s: got %v", raw, err)
		}
	}
}

func TestMCPServerEditorPreservesUnowned(t *testing.T) {
	home, launcher := testHome(t)
	config := filepath.Join(home, ".claude.json")
	before := `{"firstStartTime":"2026-01-01T00:00:00.000Z","machineID":"abc","userID":"def","mcpServers":{"other":{"type":"stdio","command":"/bin/true"}}}`
	if err := os.WriteFile(config, []byte(before), 0600); err != nil {
		t.Fatal(err)
	}
	editor := claude.MCPServerEditor{Launcher: launcher}
	after, _, err := editor.Prepare([]byte(before))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"machineID"`, `"userID"`, `"other"`, launcher, `"mcp"`, `"stdio"`} {
		if !strings.Contains(string(after), want) {
			t.Fatalf("missing %s in %s", want, after)
		}
	}
	unownedBefore, _ := editor.UnownedSemantics([]byte(before))
	unownedAfter, _ := editor.UnownedSemantics(after)
	if string(unownedBefore) != string(unownedAfter) {
		t.Fatalf("unowned semantics changed:\n%s\n%s", unownedBefore, unownedAfter)
	}
	again, _, err := editor.Prepare(after)
	if err != nil {
		t.Fatal(err)
	}
	if string(again) != string(after) {
		t.Fatal("MCP prepare not idempotent")
	}
}

func TestMCPServerEditorRejectsAmbiguous(t *testing.T) {
	editor := claude.MCPServerEditor{Launcher: "/bin/bfb"}
	for _, raw := range []string{`{invalid}`, `{"mcpServers":[1]}`, `{"mcpServers":"soon"}`} {
		if _, _, err := editor.Prepare([]byte(raw)); daemon.AsFailure(err).Diagnostic().Code != "provider_config_invalid" {
			t.Fatalf("%s: got %v", raw, err)
		}
	}
}

func applyProposal(t *testing.T, path string, editor provider.ConfigEditor, doctor provider.Doctor) provider.SetupProposal {
	t.Helper()
	proposal, err := provider.ProposeSetup(path, editor)
	if err != nil {
		t.Fatal(err)
	}
	approval := provider.SetupApproval{Approved: true, ProposalID: proposal.ID, ExpectedHash: proposal.ExpectedHash}
	if err := provider.ApplySetup(context.Background(), proposal, approval, doctor); err != nil {
		t.Fatal(err)
	}
	return proposal
}

func TestSetupAppliesBothFiles(t *testing.T) {
	home, launcher := testHome(t)
	settings := filepath.Join(home, ".claude", "settings.json")
	config := filepath.Join(home, ".claude.json")
	applyProposal(t, settings, claude.SettingsEditor{Launcher: launcher}, okDoctor)
	applyProposal(t, config, claude.MCPServerEditor{Launcher: launcher}, okDoctor)
	report := claude.Diagnose(home, launcher, stubForTest(t))
	// Only the pending local-MCP handshake may stay unverified.
	for _, check := range report.Checks {
		if check.Name == "mcp_startup" && check.Status == claude.CheckUnverified {
			continue
		}
		if check.Status != claude.CheckPassed {
			t.Fatalf("unexpected %+v", check)
		}
	}
	if report.Failed() {
		t.Fatal("healthy integration reports failure")
	}
}

func TestSetupRollbackRestoresPriorBytes(t *testing.T) {
	home, launcher := testHome(t)
	settings := filepath.Join(home, ".claude", "settings.json")
	before := []byte(`{"model":"sonnet"}`)
	if err := os.WriteFile(settings, before, 0600); err != nil {
		t.Fatal(err)
	}
	proposal, err := provider.ProposeSetup(settings, claude.SettingsEditor{Launcher: launcher})
	if err != nil {
		t.Fatal(err)
	}
	approval := provider.SetupApproval{Approved: true, ProposalID: proposal.ID, ExpectedHash: proposal.ExpectedHash}
	failing := func(context.Context) error { return daemon.AsFailure(provider.Failure("provider_probe_failed")) }
	if err := provider.ApplySetup(context.Background(), proposal, approval, failing); err == nil {
		t.Fatal("failing doctor accepted")
	}
	if string(readFile(t, settings)) != string(before) {
		t.Fatalf("prior bytes lost: %s", readFile(t, settings))
	}

	fresh := filepath.Join(home, ".claude", "fresh.json")
	proposal, err = provider.ProposeSetup(fresh, claude.SettingsEditor{Launcher: launcher})
	if err != nil {
		t.Fatal(err)
	}
	approval = provider.SetupApproval{Approved: true, ProposalID: proposal.ID, ExpectedHash: proposal.ExpectedHash}
	if err := provider.ApplySetup(context.Background(), proposal, approval, failing); err == nil {
		t.Fatal("failing doctor accepted for new file")
	}
	if _, err := os.Stat(fresh); !os.IsNotExist(err) {
		t.Fatal("failed setup left a new file behind")
	}
}

func TestSetupConcurrentEditConflicts(t *testing.T) {
	home, launcher := testHome(t)
	settings := filepath.Join(home, ".claude", "settings.json")
	if err := os.WriteFile(settings, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	proposal, err := provider.ProposeSetup(settings, claude.SettingsEditor{Launcher: launcher})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settings, []byte(`{"model":"opus"}`), 0600); err != nil {
		t.Fatal(err)
	}
	approval := provider.SetupApproval{Approved: true, ProposalID: proposal.ID, ExpectedHash: proposal.ExpectedHash}
	err = provider.ApplySetup(context.Background(), proposal, approval, okDoctor)
	requireCode(t, err, "provider_setup_conflict")
	if string(readFile(t, settings)) != `{"model":"opus"}` {
		t.Fatal("concurrent edit was overwritten")
	}
}

func TestSetupApprovalBindsExactProposal(t *testing.T) {
	home, launcher := testHome(t)
	settings := filepath.Join(home, ".claude", "settings.json")
	if err := os.WriteFile(settings, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	proposal, err := provider.ProposeSetup(settings, claude.SettingsEditor{Launcher: launcher})
	if err != nil {
		t.Fatal(err)
	}
	wrong := provider.SetupApproval{Approved: true, ProposalID: "tampered", ExpectedHash: proposal.ExpectedHash}
	requireCode(t, provider.ApplySetup(context.Background(), proposal, wrong, okDoctor), "provider_setup_denied")
	denied := provider.SetupApproval{Approved: false, ProposalID: proposal.ID, ExpectedHash: proposal.ExpectedHash}
	requireCode(t, provider.ApplySetup(context.Background(), proposal, denied, okDoctor), "provider_setup_denied")
}

func TestIntegrationHashTracksOwnedContent(t *testing.T) {
	home, launcher := testHome(t)
	empty, err := claude.IntegrationHash(home, launcher)
	if err != nil {
		t.Fatal(err)
	}
	applyProposal(t, filepath.Join(home, ".claude", "settings.json"), claude.SettingsEditor{Launcher: launcher}, okDoctor)
	configured, err := claude.IntegrationHash(home, launcher)
	if err != nil {
		t.Fatal(err)
	}
	if empty == configured {
		t.Fatal("setup kept the integration hash")
	}
	again, err := claude.IntegrationHash(home, launcher)
	if err != nil || again != configured {
		t.Fatal("integration hash unstable", err)
	}
	if _, err := claude.IntegrationHash(home, ""); err == nil {
		t.Fatal("empty launcher accepted")
	}
	if err := os.WriteFile(filepath.Join(home, ".claude", "settings.json"), []byte("{nope"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := claude.IntegrationHash(home, launcher); err == nil {
		t.Fatal("garbage settings hashed")
	}
}

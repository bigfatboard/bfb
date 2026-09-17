// ABOUTME: Certifies Grok setup transactions, doctor checks, and rollback behavior.
// ABOUTME: Exercises only temporary homes and an owned stub executable without touching real config.

package grok_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/grok"
)

func writeHooksHome(t *testing.T, command string) string {
	t.Helper()
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Dir(grok.HooksPath(home)), 0700); err != nil {
		t.Fatal(err)
	}
	editor := grok.HooksEditor{Command: command}
	after, _, err := editor.Prepare(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(grok.HooksPath(home), after, 0600); err != nil {
		t.Fatal(err)
	}
	return home
}

func TestHooksEditorInstallsAllManagedEvents(t *testing.T) {
	editor := grok.HooksEditor{Command: hookCommand()}
	after, diff, err := editor.Prepare(nil)
	if err != nil {
		t.Fatal(err)
	}
	if diff.Namespace != "grok.hooks" {
		t.Fatalf("unexpected diff namespace: %+v", diff)
	}
	text := string(after)
	fragments := append([]string{hookCommand(), `"hooks"`, `"timeout"`}, grok.ManagedHookEvents()...)
	for _, fragment := range fragments {
		if !strings.Contains(text, fragment) {
			t.Fatalf("hooks setup lost content %s:\n%s", fragment, text)
		}
	}
	if strings.Contains(text, "session_id") || strings.Contains(text, "hook_event_name") {
		t.Fatal("hooks file must use the documented camelCase contract")
	}
	unownedBefore, err := editor.UnownedSemantics(nil)
	if err != nil {
		t.Fatal(err)
	}
	unownedAfter, err := editor.UnownedSemantics(after)
	if err != nil {
		t.Fatal(err)
	}
	if string(unownedBefore) != string(unownedAfter) {
		t.Fatal("unowned semantics must stay constant for a wholly owned file")
	}
	again, _, err := editor.Prepare(after)
	if err != nil || string(again) != string(after) {
		t.Fatal("setup must be idempotent")
	}
}

func TestHooksEditorRejectsForeignContent(t *testing.T) {
	editor := grok.HooksEditor{Command: hookCommand()}
	foreign := []string{
		`{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo foreign","timeout":10}]}]}}`,
		`{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"` + hookCommand() + `","timeout":10}]}],"Stop":[]}}`,
		`{"hooks":[]}`,
		`[not json`,
	}
	for _, raw := range foreign {
		if _, _, err := editor.Prepare([]byte(raw)); err == nil {
			t.Fatalf("foreign hooks content must be denied: %s", raw)
		}
		if _, err := editor.UnownedSemantics([]byte(raw)); err == nil {
			t.Fatalf("foreign hooks content must fail semantic comparison: %s", raw)
		}
	}
	if _, _, err := (grok.HooksEditor{Command: ""}).Prepare(nil); err == nil {
		t.Fatal("empty command must be denied")
	}
}

func TestHooksSetupTransactionAndRollback(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Dir(grok.HooksPath(home)), 0700); err != nil {
		t.Fatal(err)
	}
	path := grok.HooksPath(home)
	editor := grok.HooksEditor{Command: hookCommand()}
	proposal, err := provider.ProposeSetup(path, editor)
	if err != nil {
		t.Fatal(err)
	}
	installation := provider.Installation{Executable: writeStub(t), Environment: []string{"GROK_HOME=" + home, "BFB_GROK_STUB_VERSION=" + stubVersion}}
	approval := provider.SetupApproval{Approved: true, ProposalID: proposal.ID, ExpectedHash: proposal.ExpectedHash}
	if err := provider.ApplySetup(context.Background(), proposal, approval, grok.HooksDoctor(installation.Executable, home, testLauncher, installation.Environment)); err != nil {
		t.Fatal(err)
	}
	if err := grok.CheckHooks(home, hookCommand()); err != nil {
		t.Fatal(err)
	}
	stale, err := provider.ProposeSetup(path, editor)
	if err != nil {
		t.Fatal(err)
	}
	if stale.ExpectedHash == proposal.ExpectedHash {
		t.Fatal("applied setup must advance the expected hash")
	}
	if err := os.WriteFile(path, []byte(`{"hooks":{"SessionStart":[]}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := provider.ApplySetup(context.Background(), stale, provider.SetupApproval{Approved: true, ProposalID: stale.ID, ExpectedHash: stale.ExpectedHash}, grok.HooksDoctor(installation.Executable, home, testLauncher, installation.Environment)); err == nil {
		t.Fatal("concurrent edit must abort setup")
	}
	before, _, err := editor.Prepare(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, before, 0600); err != nil {
		t.Fatal(err)
	}
	failing, err := provider.ProposeSetup(path, editor)
	if err != nil {
		t.Fatal(err)
	}
	doctor := func(context.Context) error { return provider.Failure("provider_probe_failed") }
	if err := provider.ApplySetup(context.Background(), failing, provider.SetupApproval{Approved: true, ProposalID: failing.ID, ExpectedHash: failing.ExpectedHash}, doctor); err == nil {
		t.Fatal("failed doctor must fail setup")
	}
	restored, err := os.ReadFile(path)
	if err != nil || string(restored) != string(before) {
		t.Fatalf("failed doctor must restore prior bytes: %q", restored)
	}
	fresh, err := provider.ProposeSetup(path, editor)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := provider.ApplySetup(context.Background(), fresh, provider.SetupApproval{Approved: true, ProposalID: fresh.ID, ExpectedHash: fresh.ExpectedHash}, doctor); err == nil {
		t.Fatal("failed doctor must fail setup on a new file")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("failed doctor must restore original absence")
	}
}

func TestMovedLauncherStaysHealthy(t *testing.T) {
	executable := writeStub(t)
	home := writeHooksHome(t, "/moved/bin/bfb hook ingest --provider grok")
	installation := testInstallation(t, executable, home)
	probe, err := testRegistry(t).Probe(context.Background(), "grok", installation, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if probe.Status != "healthy" {
		t.Fatal("launcher path moves must not read as drift")
	}
	requireCode(t, grok.CheckHooks(home, hookCommand()), "provider_config_invalid")
}

func TestMCPServerEditorAppendsAndPreserves(t *testing.T) {
	editor := grok.MCPServerEditor{Command: testLauncher, Args: []string{"mcp", "stdio"}}
	before := "# synthetic user config\nmodel = \"grok-4.6\"\n"
	after, diff, err := editor.Prepare([]byte(before))
	if err != nil {
		t.Fatal(err)
	}
	if diff.Namespace != "mcp_servers.bfb" {
		t.Fatalf("unexpected diff namespace: %+v", diff)
	}
	if !strings.HasPrefix(string(after), "# synthetic user config\nmodel = \"grok-4.6\"\n") {
		t.Fatalf("unrelated config must stay byte-identical:\n%s", after)
	}
	if !strings.Contains(string(after), "[mcp_servers.bfb]") || !strings.Contains(string(after), `command = "/test/bin/bfb"`) || !strings.Contains(string(after), "enabled = true") {
		t.Fatalf("server block missing:\n%s", after)
	}
	unownedBefore, err := editor.UnownedSemantics([]byte(before))
	if err != nil {
		t.Fatal(err)
	}
	unownedAfter, err := editor.UnownedSemantics(after)
	if err != nil {
		t.Fatal(err)
	}
	normalize := func(raw []byte) string { return strings.TrimRight(string(raw), "\n") + "\n" }
	if normalize(unownedBefore) != normalize(unownedAfter) {
		t.Fatalf("unowned semantics changed:\n%q\n%q", unownedBefore, unownedAfter)
	}
	again, _, err := editor.Prepare(after)
	if err != nil || string(again) != string(after) {
		t.Fatal("MCP setup must be idempotent")
	}
}

func TestMCPServerEditorConflicts(t *testing.T) {
	editor := grok.MCPServerEditor{Command: testLauncher, Args: []string{"mcp", "stdio"}}
	foreign := "model = \"x\"\n[mcp_servers.bfb]\ncommand = \"/other/bin\"\n"
	if _, _, err := editor.Prepare([]byte(foreign)); err == nil {
		t.Fatal("foreign bfb table must conflict")
	}
	after, _, err := editor.Prepare(nil)
	if err != nil {
		t.Fatal(err)
	}
	drifted := strings.Replace(string(after), `"/test/bin/bfb"`, `"/moved/bin/bfb"`, 1)
	if _, _, err := editor.Prepare([]byte(drifted)); err == nil {
		t.Fatal("drifted BFB block must conflict, never be adopted")
	}
	if _, err := editor.UnownedSemantics([]byte(drifted)); err == nil {
		t.Fatal("drifted BFB block must fail semantic comparison")
	}
	if _, _, err := (grok.MCPServerEditor{Command: "relative/bin", Args: []string{"mcp"}}).Prepare(nil); err == nil {
		t.Fatal("relative launcher must be denied")
	}
}

func TestMCPSetupTransactionRestoresAbsence(t *testing.T) {
	home := t.TempDir()
	path := grok.ConfigPath(home)
	editor := grok.MCPServerEditor{Command: testLauncher, Args: []string{"mcp", "stdio"}}
	proposal, err := provider.ProposeSetup(path, editor)
	if err != nil {
		t.Fatal(err)
	}
	executable := writeStub(t)
	list := filepath.Join(home, "mcp-list.json")
	if err := os.WriteFile(list, []byte(`[{"command":"/test/bin/bfb","args":["mcp","stdio"],"enabled":true,"name":"bfb","scope":"user"}]`), 0600); err != nil {
		t.Fatal(err)
	}
	environment := []string{"GROK_HOME=" + home, "BFB_GROK_STUB_VERSION=" + stubVersion, "BFB_GROK_STUB_MCP_LIST=" + list}
	doctor := func(context.Context) error { return provider.Failure("provider_probe_failed") }
	approval := provider.SetupApproval{Approved: true, ProposalID: proposal.ID, ExpectedHash: proposal.ExpectedHash}
	if err := provider.ApplySetup(context.Background(), proposal, approval, doctor); err == nil {
		t.Fatal("failed doctor must fail MCP setup")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("failed doctor must restore original absence")
	}
	if err := provider.ApplySetup(context.Background(), proposal, approval, grok.MCPDoctor(executable, home, testLauncher, environment)); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(raw), "[mcp_servers.bfb]") {
		t.Fatalf("applied MCP setup missing: %q %v", raw, err)
	}
}

func mcpList(t *testing.T, home, payload string) string {
	t.Helper()
	list := filepath.Join(home, "mcp-list.json")
	if err := os.WriteFile(list, []byte(payload), 0600); err != nil {
		t.Fatal(err)
	}
	return list
}

func TestDoctor(t *testing.T) {
	executable := writeStub(t)
	home := writeHooksHome(t, hookCommand())
	list := mcpList(t, home, `[{"command":"/test/bin/bfb","args":["mcp","stdio"],"enabled":true,"name":"bfb","scope":"user"}]`)
	environment := []string{"GROK_HOME=" + home, "BFB_GROK_STUB_VERSION=" + stubVersion, "BFB_GROK_STUB_MCP_LIST=" + list}
	if err := grok.Doctor(context.Background(), executable, home, testLauncher, environment); err != nil {
		t.Fatalf("healthy doctor must pass: %v", err)
	}
	badVersion := writeStub(t)
	badEnvironment := []string{"GROK_HOME=" + home, "BFB_GROK_STUB_VERSION=grok 9.9.9 (deadbeefcafe) [stable]", "BFB_GROK_STUB_MCP_LIST=" + list}
	requireCode(t, grok.Doctor(context.Background(), badVersion, home, testLauncher, badEnvironment), "provider_unsupported")
	if err := os.Remove(grok.HooksPath(home)); err != nil {
		t.Fatal(err)
	}
	requireCode(t, grok.Doctor(context.Background(), executable, home, testLauncher, environment), "provider_config_invalid")
}

func TestDoctorMCPDriftAndScope(t *testing.T) {
	executable := writeStub(t)
	home := writeHooksHome(t, hookCommand())
	good := `[{"command":"/test/bin/bfb","args":["mcp","stdio"],"enabled":true,"name":"bfb","scope":"user"}]`
	list := mcpList(t, home, good)
	environment := []string{"GROK_HOME=" + home, "BFB_GROK_STUB_VERSION=" + stubVersion, "BFB_GROK_STUB_MCP_LIST=" + list}
	for _, payload := range []string{
		`[{"command":"/moved/bin/bfb","args":["mcp","stdio"],"enabled":true,"name":"bfb","scope":"user"}]`,
		`[{"command":"/test/bin/bfb","args":["mcp","stdio"],"enabled":false,"name":"bfb","scope":"user"}]`,
		`[{"command":"/test/bin/bfb","args":["mcp","stdio"],"enabled":true,"name":"other","scope":"user"}]`,
		`[]`,
		`not json`,
	} {
		if err := os.WriteFile(list, []byte(payload), 0600); err != nil {
			t.Fatal(err)
		}
		requireCode(t, grok.Doctor(context.Background(), executable, home, testLauncher, environment), "provider_config_invalid")
	}
	if err := os.WriteFile(list, []byte(good), 0600); err != nil {
		t.Fatal(err)
	}
	if err := grok.Doctor(context.Background(), executable, home, testLauncher, environment); err != nil {
		t.Fatalf("restored registration must pass: %v", err)
	}
	requireCode(t, grok.Doctor(context.Background(), executable, home, testLauncher, []string{"BFB_GROK_STUB_VERSION=" + stubVersion}), "provider_config_invalid")
	requireCode(t, grok.Doctor(context.Background(), "relative/grok", home, testLauncher, environment), "provider_path_unsafe")
}

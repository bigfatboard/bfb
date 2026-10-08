// ABOUTME: Certifies Codex setup transactions, doctor checks, and rollback behavior.
// ABOUTME: Exercises only temporary homes and an owned stub executable without touching real config.

package codex_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/codex"
)

const testLauncher = "/test/bin/bfb"

func hookCommand() string { return codex.HookCommand(testLauncher) }

func TestHooksEditorInstallsAndPreserves(t *testing.T) {
	editor := codex.HooksEditor{Command: hookCommand()}
	before := `{"description":"synthetic user hooks","other":{"nested":[1,2]},"hooks":{"SessionStart":[{"matcher":"startup|resume","hooks":[{"type":"command","command":"echo foreign"}]}],"Stop":[]}}`
	after, diff, err := editor.Prepare([]byte(before))
	if err != nil {
		t.Fatal(err)
	}
	if diff.Namespace != "codex.hooks" {
		t.Fatalf("unexpected diff namespace: %+v", diff)
	}
	text := string(after)
	for _, fragment := range []string{hookCommand(), `"description"`, `"other"`, "echo foreign", `"SessionStart"`, `"SessionEnd"`, `"Stop"`, `"PreToolUse"`, `"PostToolUse"`, `"Interrupt"`} {
		if !strings.Contains(text, fragment) {
			t.Fatalf("hooks setup lost content %s:\n%s", fragment, text)
		}
	}
	unownedBefore, err := editor.UnownedSemantics([]byte(before))
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
	again, _, err := editor.Prepare(after)
	if err != nil || string(again) != string(after) {
		t.Fatal("setup must be idempotent")
	}
}

func TestHooksEditorRejectsInvalidConfig(t *testing.T) {
	invalid := []string{
		`[not json`,
		`{"hooks":[]}`,
		`{"hooks":{"SessionStart":{}}}`,
		`{"hooks":{"SessionStart":[{"matcher":"startup|resume","hooks":[{"type":"command","command":"echo foreign"},{"type":"command","command":"` + hookCommand() + `"}]}]},"other":1}`,
	}
	for _, raw := range invalid[:3] {
		if _, _, err := (codex.HooksEditor{Command: hookCommand()}).Prepare([]byte(raw)); err == nil {
			t.Fatalf("invalid config must be denied: %s", raw)
		}
	}
	mixed := invalid[3]
	after, _, err := (codex.HooksEditor{Command: hookCommand()}).Prepare([]byte(mixed))
	if err != nil {
		t.Fatal(err)
	}
	first, _, err := (codex.HooksEditor{Command: hookCommand()}).Prepare(after)
	if err != nil || string(first) != string(after) {
		t.Fatal("mixed foreign and BFB groups must converge")
	}
	if _, _, err := (codex.HooksEditor{Command: ""}).Prepare(nil); err == nil {
		t.Fatal("empty command must be denied")
	}
}

func TestHooksSetupTransactionAndRollback(t *testing.T) {
	home := t.TempDir()
	path := codex.HooksPath(home)
	editor := codex.HooksEditor{Command: hookCommand()}
	proposal, err := provider.ProposeSetup(path, editor)
	if err != nil {
		t.Fatal(err)
	}
	installation := provider.Installation{Executable: writeStub(t), Environment: []string{"CODEX_HOME=" + home, "BFB_CODEX_STUB_VERSION=" + stubVersion}}
	approval := provider.SetupApproval{Approved: true, ProposalID: proposal.ID, ExpectedHash: proposal.ExpectedHash}
	if err := provider.ApplySetup(context.Background(), proposal, approval, codex.HooksDoctor(installation.Executable, home, testLauncher, installation.Environment)); err != nil {
		t.Fatal(err)
	}
	if err := codex.CheckHooks(home, hookCommand()); err != nil {
		t.Fatal(err)
	}
	stale, err := provider.ProposeSetup(path, editor)
	if err != nil {
		t.Fatal(err)
	}
	if stale.ExpectedHash == proposal.ExpectedHash {
		t.Fatal("applied setup must advance the expected hash")
	}
	if err := os.WriteFile(path, []byte(`{"hooks":{}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := provider.ApplySetup(context.Background(), stale, provider.SetupApproval{Approved: true, ProposalID: stale.ID, ExpectedHash: stale.ExpectedHash}, codex.HooksDoctor(installation.Executable, home, testLauncher, installation.Environment)); err == nil {
		t.Fatal("concurrent edit must abort setup")
	}
	before := []byte(`{"hooks":{"SessionStart":[]}}`)
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
}

func TestMCPServerEditorAppendsAndPreserves(t *testing.T) {
	editor := codex.MCPServerEditor{Command: testLauncher, Args: []string{"mcp", "stdio"}}
	before := "# synthetic user config\nmodel = \"gpt-5.6-sol\"\n"
	after, diff, err := editor.Prepare([]byte(before))
	if err != nil {
		t.Fatal(err)
	}
	if diff.Namespace != "mcp_servers.bfb" {
		t.Fatalf("unexpected diff namespace: %+v", diff)
	}
	if !strings.HasPrefix(string(after), "# synthetic user config\nmodel = \"gpt-5.6-sol\"\n") {
		t.Fatalf("unrelated config must stay byte-identical:\n%s", after)
	}
	if !strings.Contains(string(after), "[mcp_servers.bfb]") || !strings.Contains(string(after), `command = "/test/bin/bfb"`) {
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
	editor := codex.MCPServerEditor{Command: testLauncher, Args: []string{"mcp", "stdio"}}
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
	if _, _, err := (codex.MCPServerEditor{Command: "relative/bin", Args: []string{"mcp"}}).Prepare(nil); err == nil {
		t.Fatal("relative launcher must be denied")
	}
}

func TestMCPSetupTransactionRestoresAbsence(t *testing.T) {
	home := t.TempDir()
	path := codex.ConfigPath(home)
	editor := codex.MCPServerEditor{Command: testLauncher, Args: []string{"mcp", "stdio"}}
	proposal, err := provider.ProposeSetup(path, editor)
	if err != nil {
		t.Fatal(err)
	}
	installation := provider.Installation{Executable: writeStub(t), Environment: []string{"CODEX_HOME=" + home, "BFB_CODEX_STUB_VERSION=" + stubVersion, "BFB_CODEX_STUB_MCP_GET=" + filepath.Join(home, "mcp-get.json")}}
	get := `{"transport":{"type":"stdio","command":"/test/bin/bfb","args":["mcp","stdio"]}}`
	if err := os.WriteFile(filepath.Join(home, "mcp-get.json"), []byte(get), 0600); err != nil {
		t.Fatal(err)
	}
	doctor := func(context.Context) error { return provider.Failure("provider_probe_failed") }
	approval := provider.SetupApproval{Approved: true, ProposalID: proposal.ID, ExpectedHash: proposal.ExpectedHash}
	if err := provider.ApplySetup(context.Background(), proposal, approval, doctor); err == nil {
		t.Fatal("failed doctor must fail MCP setup")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("failed doctor must restore original absence")
	}
	if err := provider.ApplySetup(context.Background(), proposal, approval, codex.MCPDoctor(installation.Executable, home, testLauncher, installation.Environment)); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(raw), "[mcp_servers.bfb]") {
		t.Fatalf("applied MCP setup missing: %q %v", raw, err)
	}
}

func TestDoctor(t *testing.T) {
	executable := writeStub(t)
	home := writeHome(t, hookCommand(), "")
	mcpGet := filepath.Join(home, "mcp-get.json")
	get := `{"name":"bfb","enabled":true,"transport":{"type":"stdio","command":"/test/bin/bfb","args":["mcp","stdio"]}}`
	if err := os.WriteFile(mcpGet, []byte(get), 0600); err != nil {
		t.Fatal(err)
	}
	environment := []string{"CODEX_HOME=" + home, "BFB_CODEX_STUB_VERSION=" + stubVersion, "BFB_CODEX_STUB_MCP_GET=" + mcpGet}
	if err := codex.Doctor(context.Background(), executable, home, testLauncher, environment); err != nil {
		t.Fatalf("healthy doctor must pass: %v", err)
	}
	badVersion := writeStub(t)
	badEnvironment := []string{"CODEX_HOME=" + home, "BFB_CODEX_STUB_VERSION=codex-cli 9.9.9", "BFB_CODEX_STUB_MCP_GET=" + mcpGet}
	requireCode(t, codex.Doctor(context.Background(), badVersion, home, testLauncher, badEnvironment), "provider_unsupported")
	if err := os.Remove(codex.HooksPath(home)); err != nil {
		t.Fatal(err)
	}
	requireCode(t, codex.Doctor(context.Background(), executable, home, testLauncher, environment), "provider_config_invalid")
	if err := codex.CheckInlineHooksAbsent(home); err != nil {
		t.Fatalf("absent config must not read as drift: %v", err)
	}
}

func TestDoctorInlineHooksAndMCPDrift(t *testing.T) {
	executable := writeStub(t)
	home := writeHome(t, hookCommand(), "[hooks]\n")
	mcpGet := filepath.Join(home, "mcp-get.json")
	if err := os.WriteFile(mcpGet, []byte(`{"transport":{"type":"stdio","command":"/test/bin/bfb","args":["mcp","stdio"]}}`), 0600); err != nil {
		t.Fatal(err)
	}
	environment := []string{"CODEX_HOME=" + home, "BFB_CODEX_STUB_VERSION=" + stubVersion, "BFB_CODEX_STUB_MCP_GET=" + mcpGet}
	requireCode(t, codex.Doctor(context.Background(), executable, home, testLauncher, environment), "provider_setup_conflict")
	if err := os.WriteFile(codex.ConfigPath(home), []byte(""), 0600); err != nil {
		t.Fatal(err)
	}
	if err := codex.Doctor(context.Background(), executable, home, testLauncher, environment); err != nil {
		t.Fatalf("cleared drift must pass: %v", err)
	}
	if err := os.WriteFile(mcpGet, []byte(`{"transport":{"type":"stdio","command":"/moved/bin/bfb","args":["mcp","stdio"]}}`), 0600); err != nil {
		t.Fatal(err)
	}
	requireCode(t, codex.Doctor(context.Background(), executable, home, testLauncher, environment), "provider_config_invalid")
	requireCode(t, codex.Doctor(context.Background(), executable, home, testLauncher, []string{"BFB_CODEX_STUB_VERSION=" + stubVersion}), "provider_config_invalid")
}

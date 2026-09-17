// ABOUTME: Certifies provider setup preview/approve and doctor through CLI dispatch.
// ABOUTME: Runs against an isolated home; stale approvals abort as conflicts.

package claude_test

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/qdis/bfb/internal/cli"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/providers/claude"
)

func setupRegistry() *cli.Registry {
	registry := cli.NewRegistry()
	claude.RegisterCommands(registry)
	return registry
}

func execute(t *testing.T, home string, args ...string) (int, string) {
	t.Helper()
	t.Setenv("BFB_CLAUDE_HOME", home)
	var output bytes.Buffer
	exit := setupRegistry().Execute(context.Background(), append([]string{"--json"}, args...), strings.NewReader(""), &output)
	return exit, output.String()
}

var proposalPattern = regexp.MustCompile(`proposal (?:settings|mcp): ((?:sha256:[0-9a-f]{64}):(?:sha256:[0-9a-f]{64}))`)

func extractProposals(t *testing.T, output string) []string {
	t.Helper()
	proposals := proposalPattern.FindAllStringSubmatch(output, -1)
	if proposals == nil {
		return nil
	}
	tokens := make([]string, 0, len(proposals))
	for _, match := range proposals {
		tokens = append(tokens, match[1])
	}
	return tokens
}

func TestSetupPreviewApproveCurrent(t *testing.T) {
	home := t.TempDir()
	exit, preview := execute(t, home, "provider", "setup", "claude")
	if exit != 0 {
		t.Fatalf("preview failed: %d %s", exit, preview)
	}
	if !strings.Contains(preview, "approval required") {
		t.Fatalf("missing approval gate: %s", preview)
	}
	proposals := extractProposals(t, preview)
	if len(proposals) != 2 {
		t.Fatalf("want two proposal tokens, got %v", proposals)
	}
	args := []string{"provider", "setup", "claude"}
	for _, proposal := range proposals {
		args = append(args, "--proposal", proposal)
	}
	exit, applied := execute(t, home, args...)
	if exit != 0 {
		t.Fatalf("approve failed: %d %s", exit, applied)
	}
	if !strings.Contains(applied, "applied settings") || !strings.Contains(applied, "applied mcp") {
		t.Fatalf("missing apply record: %s", applied)
	}
	exit, current := execute(t, home, "provider", "setup", "claude")
	if exit != 0 || !strings.Contains(current, "no unapproved diff") {
		t.Fatalf("re-preview not current: %d %s", exit, current)
	}
	// Re-approving consumed tokens conflicts instead of rewriting: approval
	// binds to the previewed state, and setup already advanced it.
	exit, stale := execute(t, home, args...)
	if exit == 0 || !strings.Contains(stale, "provider_setup_conflict") {
		t.Fatalf("stale re-approve: %d %s", exit, stale)
	}
}

func TestSetupStaleApprovalConflicts(t *testing.T) {
	home := t.TempDir()
	_, preview := execute(t, home, "provider", "setup", "claude")
	proposals := extractProposals(t, preview)
	if len(proposals) != 2 {
		t.Fatal("missing preview tokens")
	}
	// A concurrent edit between preview and approval aborts the transaction.
	settings := filepath.Join(home, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settings, []byte(`{"model":"opus"}`), 0600); err != nil {
		t.Fatal(err)
	}
	args := []string{"provider", "setup", "claude", "--proposal", proposals[0], "--proposal", proposals[1]}
	exit, output := execute(t, home, args...)
	if exit == 0 {
		t.Fatalf("stale approval applied: %s", output)
	}
	if !strings.Contains(output, "provider_setup_conflict") {
		t.Fatalf("missing conflict diagnostic: %s", output)
	}
	if string(mustRead(t, settings)) != `{"model":"opus"}` {
		t.Fatal("concurrent edit was overwritten")
	}
}

func TestSetupRejectsBadArgs(t *testing.T) {
	home := t.TempDir()
	for _, args := range [][]string{
		{"provider", "setup", "claude", "--proposal"},
		{"provider", "setup", "claude", "--proposal", "bogus"},
		{"provider", "setup", "claude", "--proposal", "x", "--unknown"},
		{"provider", "setup", "claude", "extra"},
		{"provider", "doctor", "claude", "extra"},
	} {
		exit, output := execute(t, home, args...)
		if exit == 0 {
			t.Fatalf("%v: accepted", args)
		}
		if !strings.Contains(output, "invalid_request") && !strings.Contains(output, "provider_setup_denied") {
			t.Fatalf("%v: missing diagnostic: %s", args, output)
		}
	}
	// A single approval never half-applies the two-file transaction.
	token := "sha256:" + strings.Repeat("a", 64) + ":sha256:" + strings.Repeat("b", 64)
	exit, output := execute(t, home, "provider", "setup", "claude", "--proposal", token)
	if exit == 0 || !strings.Contains(output, "provider_setup_denied") {
		t.Fatalf("partial approval: %d %s", exit, output)
	}
}

func TestDoctorCommand(t *testing.T) {
	home := t.TempDir()
	exit, output := execute(t, home, "provider", "doctor", "claude")
	if exit == 0 {
		t.Fatalf("doctor passed without setup: %s", output)
	}
	// Failure envelopes carry the category code; per-check lines print on success.
	if !strings.Contains(output, "provider_setup_failed") && !strings.Contains(output, "provider_unavailable") {
		t.Fatalf("missing diagnostic: %s", output)
	}
	_, preview := execute(t, home, "provider", "setup", "claude")
	args := []string{"provider", "setup", "claude"}
	for _, proposal := range extractProposals(t, preview) {
		args = append(args, "--proposal", proposal)
	}
	if exit, output := execute(t, home, args...); exit != 0 {
		t.Fatalf("setup failed: %d %s", exit, output)
	}
	exit, output = execute(t, home, "provider", "doctor", "claude")
	// The sandbox PATH may lack a real claude binary; either a clean pass or
	// an explicit unavailable/unknown-version failure is acceptable, but the
	// report must stay structured and bounded.
	if exit == 0 {
		if !strings.Contains(output, "check ") || !strings.Contains(output, "status: ok") {
			t.Fatalf("missing check lines: %s", output)
		}
	} else if !strings.Contains(output, "provider_") {
		t.Fatalf("missing diagnostic code: %s", output)
	}
	// The wire schema bounds every payload line; decode and check those units.
	var envelope struct {
		Payload struct {
			LogEntries []string `json:"log_entries"`
		} `json:"payload"`
	}
	if err := json.Unmarshal([]byte(output), &envelope); err != nil {
		t.Fatalf("invalid envelope: %v", err)
	}
	if len(envelope.Payload.LogEntries) > 200 {
		t.Fatal("too many diagnostic lines")
	}
	for _, line := range envelope.Payload.LogEntries {
		if len(line) > 512 {
			t.Fatalf("oversized diagnostic line: %s", line[:80])
		}
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestSetupPayloadStaysBounded(t *testing.T) {
	home := t.TempDir()
	exit, preview := execute(t, home, "provider", "setup", "claude")
	if exit != 0 {
		t.Fatal(preview)
	}
	if !strings.Contains(preview, "log_entries") {
		t.Fatalf("missing contracted payload: %s", preview)
	}
	if code := daemon.ExitCode(&daemon.Failure{Code: "provider_setup_conflict"}); code != 6 {
		t.Fatalf("conflict exit %d", code)
	}
}

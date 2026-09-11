// ABOUTME: Tests exact setup approval, semantic preservation, concurrent edits and atomic rollback.
// ABOUTME: Exercises process-crash recovery using synthetic configuration files in private temporary directories.

package provider_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/fake"
)

func setupFile(t *testing.T, before string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "settings.json")
	if before != "" {
		if err := os.WriteFile(path, []byte(before), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return path
}

func proposalFor(t *testing.T, path string) (provider.SetupProposal, provider.SetupApproval) {
	t.Helper()
	proposal, err := provider.ProposeSetup(path, fake.ConfigEditor{})
	if err != nil {
		t.Fatal(err)
	}
	return proposal, provider.SetupApproval{Approved: true, ProposalID: proposal.ID, ExpectedHash: proposal.ExpectedHash}
}

func readConfig(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func healthyDoctor(context.Context) error { return nil }

func TestSetupExplicitApprovalAndOwnedSemanticPreservation(t *testing.T) {
	before := `{"user":{"model":"leave-me","large_integer":9007199254740993},"hooks":[{"command":"unrelated"}],"bfb":{"old":true}}`
	path := setupFile(t, before)
	proposal, approval := proposalFor(t, path)
	if string(readConfig(t, path)) != before {
		t.Fatal("proposal wrote configuration")
	}
	public, _ := json.Marshal(proposal)
	if bytes.Contains(public, []byte("leave-me")) || bytes.Contains(public, []byte(path)) {
		t.Fatal("proposal exposes unowned/private fields")
	}
	if proposal.Diff.Namespace != "bfb" || !bytes.Contains(proposal.Diff.Before, []byte("old")) {
		t.Fatal("missing owned diff")
	}
	for _, invalid := range []provider.SetupApproval{
		{}, {Approved: true, ProposalID: "other", ExpectedHash: approval.ExpectedHash},
		{Approved: true, ProposalID: approval.ProposalID, ExpectedHash: "old"},
	} {
		requireCode(t, provider.ApplySetup(context.Background(), proposal, invalid, healthyDoctor), "provider_setup_denied")
		if string(readConfig(t, path)) != before {
			t.Fatal("unapproved write")
		}
	}
	tampered := proposal
	tampered.Diff.After = json.RawMessage(`{"changed_by_caller":true}`)
	requireCode(t, provider.ApplySetup(context.Background(), tampered, approval, healthyDoctor), "provider_setup_denied")
	if err := provider.ApplySetup(context.Background(), proposal, approval, healthyDoctor); err != nil {
		t.Fatal(err)
	}
	unownedBefore, _ := (fake.ConfigEditor{}).UnownedSemantics([]byte(before))
	unownedAfter, _ := (fake.ConfigEditor{}).UnownedSemantics(readConfig(t, path))
	if !bytes.Equal(unownedBefore, unownedAfter) || !bytes.Contains(unownedAfter, []byte("9007199254740993")) {
		t.Fatal("unowned config changed")
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".recovery") || strings.HasPrefix(entry.Name(), ".bfb-write-") {
			t.Fatal("completed setup left recovery data")
		}
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0600 {
		t.Fatal("configuration permissions widened")
	}
	requireCode(t, provider.ApplySetup(context.Background(), proposal, approval, healthyDoctor), "provider_setup_conflict")
}

type unownedEditor struct{ fake.ConfigEditor }

func (editor unownedEditor) Prepare(before []byte) ([]byte, provider.OwnedDiff, error) {
	after, diff, err := editor.ConfigEditor.Prepare(before)
	if err != nil {
		return nil, diff, err
	}
	var object map[string]any
	_ = json.Unmarshal(after, &object)
	object["unowned"] = "changed"
	after, err = json.Marshal(object)
	return after, diff, err
}

func TestSetupRefusesUnownedChangesAndAmbiguousJSON(t *testing.T) {
	path := setupFile(t, `{"unowned":"preserve"}`)
	_, err := provider.ProposeSetup(path, unownedEditor{})
	requireCode(t, err, "provider_setup_denied")
	for _, raw := range []string{`{"unowned":1,"unowned":2}`, `{"nested":{"value":1,"value":2}}`, `null`, `[]`, `{}{}`} {
		path := setupFile(t, raw)
		_, err := provider.ProposeSetup(path, fake.ConfigEditor{})
		requireCode(t, err, "provider_setup_denied")
	}
}

func TestSetupConcurrentEditsAndSharedLock(t *testing.T) {
	t.Run("stale_before_apply", func(t *testing.T) {
		path := setupFile(t, `{"user":1}`)
		proposal, approval := proposalFor(t, path)
		other := `{"user":"external-edit"}`
		if err := os.WriteFile(path, []byte(other), 0600); err != nil {
			t.Fatal(err)
		}
		requireCode(t, provider.ApplySetup(context.Background(), proposal, approval, healthyDoctor), "provider_setup_conflict")
		if string(readConfig(t, path)) != other {
			t.Fatal("external edit overwritten")
		}
	})
	t.Run("competing_approved_writer", func(t *testing.T) {
		path := setupFile(t, `{"user":1}`)
		proposal, approval := proposalFor(t, path)
		entered, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
		go func() {
			done <- provider.ApplySetup(context.Background(), proposal, approval, func(context.Context) error { close(entered); <-release; return nil })
		}()
		<-entered
		other, otherApproval := proposalFor(t, path)
		err := provider.ApplySetup(context.Background(), other, otherApproval, healthyDoctor)
		close(release)
		if completed := <-done; completed != nil {
			t.Fatal(completed)
		}
		requireCode(t, err, "provider_setup_conflict")
	})
	for _, doctorFails := range []bool{false, true} {
		name := "edit_during_healthy_doctor"
		if doctorFails {
			name = "edit_during_failed_doctor"
		}
		t.Run(name, func(t *testing.T) {
			path := setupFile(t, `{"user":1}`)
			proposal, approval := proposalFor(t, path)
			other := `{"user":"edit-during-doctor"}`
			err := provider.ApplySetup(context.Background(), proposal, approval, func(context.Context) error {
				if err := os.WriteFile(path, []byte(other), 0600); err != nil {
					return err
				}
				if doctorFails {
					return errors.New("private-doctor-failure")
				}
				return nil
			})
			requireCode(t, err, "provider_setup_conflict")
			if string(readConfig(t, path)) != other {
				t.Fatal("doctor-time edit lost")
			}
			requireCode(t, provider.RecoverSetup(path), "provider_setup_conflict")
			recoveryFound := false
			entries, _ := os.ReadDir(filepath.Dir(path))
			for _, entry := range entries {
				if strings.HasSuffix(entry.Name(), ".recovery") {
					recoveryFound = true
					info, _ := entry.Info()
					if info.Mode().Perm() != 0600 {
						t.Fatal("recovery copy exposed")
					}
				}
			}
			if !recoveryFound {
				t.Fatal("conflict discarded recovery copy")
			}
		})
	}
}

func TestSetupDoctorFailureRestoresExactPriorBytes(t *testing.T) {
	for _, name := range []string{"existing", "missing", "large"} {
		t.Run(name, func(t *testing.T) {
			before := "{\n  \"user\": {\"formatting\": \"preserve me\"}\n}\n"
			if name == "missing" {
				before = ""
			}
			if name == "large" {
				before = `{"padding":"` + strings.Repeat("x", 1600000) + `"}`
			}
			path := setupFile(t, before)
			proposal, approval := proposalFor(t, path)
			err := provider.ApplySetup(context.Background(), proposal, approval, func(context.Context) error { return errors.New("secret-doctor-failure") })
			requireCode(t, err, "provider_setup_failed")
			if strings.Contains(err.Error(), "secret") {
				t.Fatal("raw doctor diagnostics escaped")
			}
			if name == "missing" {
				if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("rollback did not restore absence")
				}
			} else if string(readConfig(t, path)) != before {
				t.Fatal("rollback changed original bytes")
			}
			if err := provider.RecoverSetup(path); err != nil {
				t.Fatal("rollback not idempotent", err)
			}
		})
	}
}

func TestSetupRejectsSymlinksAndDirectoryReplacement(t *testing.T) {
	t.Run("config_symlink", func(t *testing.T) {
		path := setupFile(t, "{}")
		link := path + ".link"
		if err := os.Symlink(path, link); err != nil {
			t.Fatal(err)
		}
		_, err := provider.ProposeSetup(link, fake.ConfigEditor{})
		requireCode(t, err, "provider_path_unsafe")
	})
	t.Run("parent_replacement", func(t *testing.T) {
		root := t.TempDir()
		directory := filepath.Join(root, "provider")
		if err := os.Mkdir(directory, 0700); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(directory, "settings.json")
		if err := os.WriteFile(path, []byte("{}"), 0600); err != nil {
			t.Fatal(err)
		}
		proposal, approval := proposalFor(t, path)
		if err := os.Rename(directory, filepath.Join(root, "previous")); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(directory, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("{}"), 0600); err != nil {
			t.Fatal(err)
		}
		requireCode(t, provider.ApplySetup(context.Background(), proposal, approval, healthyDoctor), "provider_setup_conflict")
	})
}

func TestSetupProcessCrashRecovery(t *testing.T) {
	for _, name := range []string{"existing", "missing"} {
		t.Run(name, func(t *testing.T) {
			before := "{ \"unrelated\": true }\n"
			if name == "missing" {
				before = ""
			}
			path := setupFile(t, before)
			command := exec.Command(os.Args[0], "-test.run=^TestSetupCrashWorker$")
			command.Env = append(os.Environ(), "BFB_TEST_SETUP_CRASH="+path)
			err := command.Run()
			var exited *exec.ExitError
			if !errors.As(err, &exited) || exited.ExitCode() != 23 {
				t.Fatalf("crash helper outcome: %v", err)
			}
			if !bytes.Contains(readConfig(t, path), []byte("integration_version")) {
				t.Fatal("helper did not crash after publishing")
			}
			proposal, approval := proposalFor(t, path)
			requireCode(t, provider.ApplySetup(context.Background(), proposal, approval, healthyDoctor), "provider_setup_conflict")
			if err := provider.RecoverSetup(path); err != nil {
				t.Fatal(err)
			}
			if before == "" {
				if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("recovery did not restore absence")
				}
			} else if string(readConfig(t, path)) != before {
				t.Fatal("crash recovery lost prior bytes")
			}
		})
	}
}

func TestSetupCrashWorker(t *testing.T) {
	path := os.Getenv("BFB_TEST_SETUP_CRASH")
	if path == "" {
		return
	}
	proposal, approval := proposalFor(t, path)
	_ = provider.ApplySetup(context.Background(), proposal, approval, func(context.Context) error { os.Exit(23); return nil })
	os.Exit(24)
}

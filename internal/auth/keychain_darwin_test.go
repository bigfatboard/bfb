// ABOUTME: Verifies real signed-daemon access and unsigned same-user Keychain denial on macOS.
// ABOUTME: Uses unique synthetic workspace records and retains no private keys or credential values.

//go:build darwin && cgo

package auth

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
)

func TestNativeCredentialACL(t *testing.T) {
	if _, err := NewKeychain(); err != ErrCredentialUnavailable {
		t.Fatalf("unsigned Go test executable obtained native store: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	run := func(name string, arguments ...string) []byte {
		t.Helper()
		output, err := exec.CommandContext(ctx, name, arguments...).CombinedOutput()
		if err != nil {
			t.Fatalf("native credential fixture command %s failed: %v: %s", filepath.Base(name), err, output)
		}
		return output
	}
	identities := run("security", "find-identity", "-v", "-p", "codesigning")
	match := regexp.MustCompile(`(?m)^\s*\d+\) ([A-F0-9]{40}) "Apple Development:`).FindSubmatch(identities)
	if match == nil {
		t.Fatal("native Keychain acceptance requires an Apple development signing identity; not skipped")
	}
	identity := string(match[1])
	directory := t.TempDir()
	trusted := filepath.Join(directory, "bfb-daemon")
	unsigned := filepath.Join(directory, "unsigned-read")
	adHoc := filepath.Join(directory, "adhoc-read")
	unrelated := filepath.Join(directory, "unrelated-read")
	run("go", "build", "-o", trusted, "./testdata/keychain-probe")
	run("codesign", "--force", "--sign", identity, "--identifier", DaemonSigningIdentifier, "--options", "runtime", trusted)
	run("xcrun", "swiftc", "testdata/keychain-read.swift", "-o", unsigned)
	run("codesign", "--remove-signature", unsigned)
	copy, err := os.ReadFile(unsigned)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(unrelated, copy, 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(adHoc, copy, 0700); err != nil {
		t.Fatal(err)
	}
	run("codesign", "--force", "--sign", "-", "--identifier", DaemonSigningIdentifier, adHoc)
	run("codesign", "--force", "--sign", identity, "--identifier", "com.tenira.bfb.unrelated-test", "--options", "runtime", unrelated)
	workspaceA, workspaceB := daemon.NewRequestID(), daemon.NewRequestID()
	runnerA, runnerB := daemon.NewRequestID(), daemon.NewRequestID()
	for _, enrollment := range [][2]string{{workspaceA, runnerA}, {workspaceB, runnerB}} {
		workspace, runner := enrollment[0], enrollment[1]
		t.Cleanup(func() {
			cleanupContext, stop := context.WithTimeout(context.Background(), 10*time.Second)
			defer stop()
			if output, err := exec.CommandContext(cleanupContext, trusted, "delete", workspace, runner).CombinedOutput(); err != nil {
				t.Errorf("remove exact synthetic credential pair: %v: %s", err, output)
			}
		})
	}
	publicA := run(trusted, "create", workspaceA, runnerA)
	publicB := run(trusted, "create", workspaceB, runnerB)
	if string(publicA) == string(publicB) || !strings.Contains(string(publicA), `"P-256"`) || strings.Contains(string(publicA), `"d"`) {
		t.Fatal("workspace public keys were not distinct exact public keys")
	}
	for _, enrollment := range [][2]string{{workspaceA, runnerA}, {workspaceB, runnerB}} {
		for _, mode := range []string{"check", "replace", "check"} {
			var assertions map[string]bool
			if err = json.Unmarshal(run(trusted, mode, enrollment[0], enrollment[1]), &assertions); err != nil {
				t.Fatal(err)
			}
			for assertion, passed := range assertions {
				if !passed {
					t.Fatalf("signed process assertion %s failed", assertion)
				}
			}
		}
		for _, kind := range []CredentialKind{RunnerKey, RunnerToken} {
			account, _ := (CredentialRef{Kind: kind, WorkspaceID: enrollment[0], ID: enrollment[1]}).Account()
			// Apple silicon may kill unsigned Mach-O before any Keychain call. The
			// ad-hoc clone below additionally exercises Keychain's own denial.
			unsignedOutput, unsignedErr := exec.CommandContext(ctx, unsigned, account).CombinedOutput()
			if unsignedErr == nil {
				if !strings.Contains(string(unsignedOutput), `"read_allowed":false`) {
					t.Fatal("unsigned probe was not denied")
				}
			} else if exit, ok := unsignedErr.(*exec.ExitError); !ok || exit.Sys().(syscall.WaitStatus).Signal() != syscall.SIGKILL {
				t.Fatalf("unsigned probe failed without a kernel denial: %v", unsignedErr)
			}
			for _, probe := range []string{adHoc, unrelated} {
				var result struct {
					ReadAllowed bool `json:"read_allowed"`
					Status      int  `json:"os_status"`
				}
				if err = json.Unmarshal(run(probe, account), &result); err != nil || result.ReadAllowed || result.Status == 0 || result.Status == -25300 {
					t.Fatalf("OS did not deny access to the existing protected item: %#v (%v)", result, err)
				}
			}
		}
	}
}

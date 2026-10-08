// ABOUTME: Proves immutable assignment publication, authenticated replay and non-mutating helper access.
// ABOUTME: Rejects corrupt, substituted and confused local records without repairing their evidence.

package supervisor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
	"golang.org/x/sys/unix"
)

func fixtureAssignmentFiles(t *testing.T) (*AssignmentFiles, generated.LocalExecutionAssignment, SupervisorIdentity, time.Time) {
	t.Helper()
	intents, local, claim, now := fixtureIntents(t)
	assignment := issueFixture(t, intents, claim, now)
	if offered, err := intents.Offer(context.Background(), assignment.IntentID); err != nil || !offered {
		t.Fatal("offer", err)
	}
	self := SupervisorIdentity{Process: fixtureProcess(1201, 1, 1201), ExecutableHash: provider.Hash(nil)}
	assignment, err := intents.Register(context.Background(), assignment.IntentID, self, now)
	if err != nil {
		t.Fatal(err)
	}
	wire, err := assignment.wire()
	if err != nil {
		t.Fatal(err)
	}
	files, err := OpenAssignmentFiles(local.Paths.Root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = files.Close() })
	return files, wire, self, now
}

func TestAssignmentPublicationIsImmutableAndReadableAfterLaunchExpiry(t *testing.T) {
	files, assignment, self, now := fixtureAssignmentFiles(t)
	if err := files.Publish(assignment); err != nil {
		t.Fatal(err)
	}
	reader, err := ReadAssignmentFiles(filepath.Dir(files.directory.file.Name()))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	before, err := os.Stat(filepath.Join(files.directory.file.Name(), assignment.TerminalIntentId+".assignment.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := files.Publish(assignment); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(filepath.Join(files.directory.file.Name(), assignment.TerminalIntentId+".assignment.json"))
	if err != nil || !os.SameFile(before, after) || before.ModTime() != after.ModTime() {
		t.Fatal("idempotent publication replaced evidence", err)
	}
	stored, err := reader.Read(assignment.TerminalIntentId)
	if err != nil || !reflect.DeepEqual(assignment, stored) {
		t.Fatal("historical read mismatch", err)
	}
	if _, err := registeredResponse(map[string]any{"execution_assignment": stored}, assignment.TerminalIntentId, self, now.Add(3*time.Minute)); err == nil {
		t.Fatal("historical evidence authorized a late launch")
	}
	assertFailure(t, reader.Publish(assignment), "unsafe_state")
	changed := assignment
	changed.ProviderIdentityHash = provider.Hash([]byte("different local installation"))
	assertFailure(t, files.Publish(changed), "execution_assignment_invalid")
	stored, err = reader.Read(assignment.TerminalIntentId)
	if err != nil || !reflect.DeepEqual(assignment, stored) {
		t.Fatal("conflicting publication changed original", err)
	}
}

func TestConcurrentAssignmentPublicationAcrossOpenFiles(t *testing.T) {
	files, assignment, _, _ := fixtureAssignmentFiles(t)
	const count = 24
	instances := []*AssignmentFiles{files}
	for range count - 1 {
		opened, err := OpenAssignmentFiles(filepath.Dir(files.directory.file.Name()))
		if err != nil {
			t.Fatal(err)
		}
		defer opened.Close()
		instances = append(instances, opened)
	}
	var workers sync.WaitGroup
	for _, instance := range instances {
		workers.Go(func() {
			if err := instance.Publish(assignment); err != nil {
				t.Error(err)
			}
		})
	}
	workers.Wait()
	stored, err := files.Read(assignment.TerminalIntentId)
	if err != nil || !reflect.DeepEqual(stored, assignment) {
		t.Fatal("concurrent publication lost assignment", err)
	}
}

func TestAssignmentFileFaultsFailWithoutRepair(t *testing.T) {
	for _, fault := range []string{"corrupt", "oversize", "symlink", "hardlink", "public", "wrong_key", "copied_name", "changed_claim", "trailing_json"} {
		t.Run(fault, func(t *testing.T) {
			files, assignment, _, _ := fixtureAssignmentFiles(t)
			if err := files.Publish(assignment); err != nil {
				t.Fatal(err)
			}
			name := assignment.TerminalIntentId + ".assignment.json"
			path := filepath.Join(files.directory.file.Name(), name)
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			switch fault {
			case "corrupt":
				err = os.WriteFile(path, []byte(`{"record":{},"authenticator":"invalid"}`), 0600)
			case "oversize":
				err = os.WriteFile(path, []byte(strings.Repeat("x", maxPrivateRecord+1)), 0600)
			case "symlink":
				if err = os.Rename(path, path+".original"); err == nil {
					err = os.Symlink(path+".original", path)
				}
			case "hardlink":
				err = os.Link(path, path+".alias")
			case "public":
				err = os.Chmod(path, 0644)
			case "wrong_key":
				files.directory.key = []byte(strings.Repeat("x", 32))
			case "copied_name":
				assignment.TerminalIntentId = "00000000-0000-4000-8000-000000000001"
				path = filepath.Join(files.directory.file.Name(), assignment.TerminalIntentId+".assignment.json")
				err = os.WriteFile(path, data, 0600)
			case "changed_claim":
				copy := assignment
				copy.Claim.Specification.AssignmentGeneration++
				err = files.directory.write(name, copy)
			case "trailing_json":
				err = os.WriteFile(path, append(data, []byte(` {}`)...), 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := files.Read(assignment.TerminalIntentId); err == nil {
				t.Fatal("faulty record read successfully")
			}
			if err := files.Publish(assignment); err == nil {
				t.Fatal("faulty evidence overwritten")
			}
			after, err := os.ReadFile(path)
			if err != nil || string(before) != string(after) {
				t.Fatal("faulty evidence changed", err)
			}
		})
	}
}

func TestConflictingConcurrentAssignmentPublicationHasOneValue(t *testing.T) {
	files, assignment, _, _ := fixtureAssignmentFiles(t)
	other, err := OpenAssignmentFiles(filepath.Dir(files.directory.file.Name()))
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	changed := assignment
	changed.ProviderIdentityHash = provider.Hash([]byte("conflicting provider"))
	results := make(chan error, 2)
	var workers sync.WaitGroup
	for index, instance := range []*AssignmentFiles{files, other} {
		candidate := []generated.LocalExecutionAssignment{assignment, changed}[index]
		workers.Go(func() { results <- instance.Publish(candidate) })
	}
	workers.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else {
			assertFailure(t, err, "execution_assignment_invalid")
			conflicts++
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("publication winners %d, conflicts %d", successes, conflicts)
	}
}

func TestAssignmentGuardContentionIsBounded(t *testing.T) {
	files, assignment, _, _ := fixtureAssignmentFiles(t)
	guard, err := files.directory.open(assignment.TerminalIntentId+".assignment.json.lock", unix.O_CREAT|unix.O_RDWR)
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Close()
	if err := unix.Flock(int(guard.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	assertFailure(t, files.Publish(assignment), "storage_failed")
	if time.Since(start) > 2*time.Second {
		t.Fatal("publication did not bound guard contention")
	}
	if err := unix.Flock(int(guard.Fd()), unix.LOCK_UN); err != nil {
		t.Fatal(err)
	}
	if err := files.Publish(assignment); err != nil {
		t.Fatal("released guard prevented retry", err)
	}
}

func TestReadOnlyAssignmentFilesCannotInitializeOrWrite(t *testing.T) {
	for _, fault := range []string{"missing_directory", "missing_key", "partial_key", "key_symlink", "root_symlink", "root_public"} {
		t.Run(fault, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "execution-records")
			if fault != "missing_directory" {
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			}
			switch fault {
			case "partial_key":
				if err := os.WriteFile(filepath.Join(path, "authentication.key"), []byte("short"), 0600); err != nil {
					t.Fatal(err)
				}
			case "key_symlink":
				if err := os.Symlink(filepath.Join(root, "missing"), filepath.Join(path, "authentication.key")); err != nil {
					t.Fatal(err)
				}
			case "root_symlink":
				alias := filepath.Join(t.TempDir(), "alias")
				if err := os.Symlink(root, alias); err != nil {
					t.Fatal(err)
				}
				root = alias
			case "root_public":
				if err := os.Chmod(root, 0755); err != nil {
					t.Fatal(err)
				}
			}
			before, _ := os.ReadDir(path)
			if reader, err := ReadAssignmentFiles(root); err == nil {
				_ = reader.Close()
				t.Fatal("reader initialized incomplete state")
			}
			after, _ := os.ReadDir(path)
			if !reflect.DeepEqual(before, after) {
				t.Fatal("read-only open created state")
			}
			if fault == "missing_directory" {
				if _, err := os.Lstat(path); !os.IsNotExist(err) {
					t.Fatal("reader created directory")
				}
			}
		})
	}
	files, assignment, _, _ := fixtureAssignmentFiles(t)
	if err := files.Publish(assignment); err != nil {
		t.Fatal(err)
	}
	reader, err := ReadAssignmentFiles(filepath.Dir(files.directory.file.Name()))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	for _, flags := range []int{unix.O_WRONLY, unix.O_RDWR, unix.O_CREAT, unix.O_TRUNC, unix.O_APPEND} {
		if file, err := reader.directory.open("authentication.key", flags); err == nil {
			_ = file.Close()
			t.Fatal("reader gained write access")
		}
	}
	assertFailure(t, reader.directory.write("forbidden.json", json.RawMessage(`{}`)), "unsafe_state")
}

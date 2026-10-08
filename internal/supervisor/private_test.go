// ABOUTME: Verifies bounded authenticated local records and rejects unsafe filesystem substitutions.
// ABOUTME: Keeps corrupt recovery evidence intact instead of silently creating a new launch authority.

package supervisor

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"golang.org/x/sys/unix"
)

func TestConcurrentPrivateFileCreation(t *testing.T) {
	store := fixtureLockStore(t)
	var workers sync.WaitGroup
	for range 24 {
		workers.Go(func() {
			file, err := store.directory.open("creation.lock", unix.O_CREAT|unix.O_RDWR)
			if err != nil {
				t.Errorf("concurrent open: %v", err)
				return
			}
			_ = file.Close()
		})
	}
	workers.Wait()
}

func TestPrivateRecordFaultsCannotReleaseOccupancy(t *testing.T) {
	for _, fault := range []string{"corrupt", "oversize", "missing", "symlink", "hardlink", "public", "wrong_key", "copied_name", "trailing_json"} {
		t.Run(fault, func(t *testing.T) {
			store := fixtureLockStore(t)
			binding := fixtureBinding()
			lock, err := store.Acquire(binding)
			if err != nil {
				t.Fatal(err)
			}
			if err = lock.Close(); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(store.directory.file.Name(), lockName(binding.PhysicalWorktreeHash, ".json"))
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			switch fault {
			case "corrupt":
				err = os.WriteFile(path, []byte(`{"record":{},"authenticator":"invalid"}`), 0600)
			case "oversize":
				err = os.WriteFile(path, []byte(strings.Repeat("x", maxPrivateRecord+1)), 0600)
			case "missing":
				err = os.Remove(path)
			case "symlink":
				target := filepath.Join(t.TempDir(), "foreign")
				if err = os.WriteFile(target, data, 0600); err == nil {
					err = os.Remove(path)
				}
				if err == nil {
					err = os.Symlink(target, path)
				}
			case "hardlink":
				err = os.Link(path, filepath.Join(t.TempDir(), "alias"))
			case "public":
				err = os.Chmod(path, 0644)
			case "wrong_key":
				store.directory.key = []byte(strings.Repeat("x", 32))
			case "copied_name":
				other := "sha256:" + strings.Repeat("b", 64)
				err = os.WriteFile(filepath.Join(store.directory.file.Name(), lockName(other, ".json")), data, 0600)
				binding.PhysicalWorktreeHash = other
			case "trailing_json":
				err = os.WriteFile(path, append(data, []byte(` {}`)...), 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			_, err = store.Acquire(binding)
			assertFailure(t, err, "containment_unknown")
			assertFailure(t, store.recoverLocal(binding, nil), "containment_unknown")
		})
	}
}

func TestPrivateDirectoryAndLockSubstitutionFailClosed(t *testing.T) {
	for _, fault := range []string{"directory_symlink", "directory_public", "directory_replaced", "lock_replaced", "lock_symlink", "lock_fifo"} {
		t.Run(fault, func(t *testing.T) {
			store := fixtureLockStore(t)
			binding := fixtureBinding()
			lock, err := store.Acquire(binding)
			if err != nil {
				t.Fatal(err)
			}
			defer lock.Close()
			root := store.directory.file.Name()
			path := filepath.Join(root, lockName(binding.PhysicalWorktreeHash, ".lock"))
			switch fault {
			case "directory_symlink":
				if err = os.Rename(root, root+"-original"); err == nil {
					err = os.Symlink(root+"-original", root)
				}
			case "directory_public":
				err = os.Chmod(root, 0755)
			case "directory_replaced":
				if err = os.Rename(root, root+"-original"); err == nil {
					err = os.Mkdir(root, 0700)
				}
			case "lock_replaced", "lock_symlink", "lock_fifo":
				if err = os.Rename(path, path+"-original"); err == nil {
					switch fault {
					case "lock_replaced":
						err = os.WriteFile(path, []byte("other inode"), 0600)
					case "lock_symlink":
						err = os.Symlink(path+"-original", path)
					case "lock_fifo":
						err = unix.Mkfifo(path, 0600)
					}
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			assertFailure(t, lock.Release(), "containment_unknown")
			if _, err = lock.Observe(); err == nil {
				t.Fatal("substituted lock stayed verified")
			}
		})
	}
}

func TestPrivateRecordStrictSemantics(t *testing.T) {
	store := fixtureLockStore(t)
	for _, name := range []string{"../other", "/absolute", ".", "..", "name/child"} {
		if err := store.directory.write(name, map[string]string{"synthetic": "value"}); err == nil {
			t.Fatal("unsafe private record name accepted")
		}
	}
	type sample struct {
		Value string `json:"value"`
	}
	for _, invalid := range []string{`{"value":"one","value":"two"}`, `{"value":"one","extra":true}`, `{"Value":"one"}`} {
		name := "strict.json"
		envelope := `{"record":` + invalid + `,"authenticator":"` + store.directory.authenticate(name, []byte(invalid)) + `"}`
		if err := os.WriteFile(filepath.Join(store.directory.file.Name(), name), []byte(envelope), 0600); err != nil {
			t.Fatal(err)
		}
		var result sample
		assertFailure(t, store.directory.read(name, &result), "containment_unknown")
	}
}

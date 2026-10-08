// ABOUTME: Creates run-specific private artifact directories only outside the registered checkout.
// ABOUTME: Pins directory device and inode identity and rejects aliases, replacement and unsafe permissions.

package supervisor

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"
)

type ArtifactDirectory struct {
	Path     string `json:"path"`
	Identity string `json:"identity"`
}

// Compare native ancestor identities, not case-sensitive path prefixes. The
// state directory must be outside even an aliased/case-folded checkout root.
func outsideCheckout(state, checkoutRoot string) bool {
	if !localPath(state) || !localPath(checkoutRoot) {
		return false
	}
	checkout, err := os.Stat(checkoutRoot)
	if err != nil || !checkout.IsDir() {
		return false
	}
	for path := state; ; path = filepath.Dir(path) {
		current, err := os.Stat(path)
		if err != nil || !current.IsDir() || os.SameFile(checkout, current) {
			return false
		}
		if filepath.Dir(path) == path {
			return true
		}
	}
}

func privateChildDirectory(parent *os.File, name string, create bool) (*os.File, error) {
	if !privateName.MatchString(name) || name == "." || name == ".." {
		return nil, failure("unsafe_state")
	}
	if create {
		if err := unix.Mkdirat(int(parent.Fd()), name, 0700); err != nil && !errors.Is(err, unix.EEXIST) {
			return nil, failure("unsafe_state")
		}
		if err := parent.Sync(); err != nil {
			return nil, failure("storage_failed")
		}
	}
	fd, err := unix.Openat(int(parent.Fd()), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, failure("unsafe_state")
	}
	file := os.NewFile(uintptr(fd), filepath.Join(parent.Name(), name))
	info, err := file.Stat()
	current, currentErr := os.Lstat(file.Name())
	if err != nil || currentErr != nil || !info.IsDir() || !privateOwned(info) || !current.IsDir() || !os.SameFile(info, current) {
		_ = file.Close()
		return nil, failure("unsafe_state")
	}
	return file, nil
}

func openArtifacts(root, execution, checkoutRoot string, create bool) (ArtifactDirectory, error) {
	if !localPath(root) || root == "/" || !executionID.MatchString(execution) {
		return ArtifactDirectory{}, failure("unsafe_state")
	}
	rootInfo, err := os.Lstat(root)
	if err != nil || !rootInfo.IsDir() || !privateOwned(rootInfo) {
		return ArtifactDirectory{}, failure("unsafe_state")
	}
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil || !outsideCheckout(canonical, checkoutRoot) {
		return ArtifactDirectory{}, failure("unsafe_state")
	}
	fd, err := unix.Open(canonical, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return ArtifactDirectory{}, failure("unsafe_state")
	}
	state := os.NewFile(uintptr(fd), canonical)
	defer state.Close()
	actual, err := state.Stat()
	if err != nil || !os.SameFile(rootInfo, actual) {
		return ArtifactDirectory{}, failure("unsafe_state")
	}
	parent, err := privateChildDirectory(state, "run-artifacts", create)
	if err != nil {
		return ArtifactDirectory{}, err
	}
	defer parent.Close()
	file, err := privateChildDirectory(parent, execution, create)
	if err != nil {
		return ArtifactDirectory{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return ArtifactDirectory{}, failure("unsafe_state")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !outsideCheckout(canonical, checkoutRoot) {
		return ArtifactDirectory{}, failure("unsafe_state")
	}
	for _, directory := range []*os.File{state, parent, file} {
		expected, expectedErr := directory.Stat()
		current, currentErr := os.Lstat(directory.Name())
		if expectedErr != nil || currentErr != nil || !current.IsDir() || !privateOwned(current) || !os.SameFile(expected, current) {
			return ArtifactDirectory{}, failure("unsafe_state")
		}
	}
	return ArtifactDirectory{Path: file.Name(), Identity: fmt.Sprintf("%d:%d", stat.Dev, stat.Ino)}, nil
}

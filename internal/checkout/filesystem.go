// ABOUTME: Resolves and identifies actual directories without treating user spelling as identity.
// ABOUTME: Keeps canonical paths local and derives a path-free physical-worktree lock key.

package checkout

import (
	"os"
	"path/filepath"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

func canonicalDirectory(path string) (canonical, identity string, err error) {
	if !filepath.IsAbs(path) || len(path) > 4096 || !utf8.ValidString(path) || hasControl(path) {
		return "", "", failure("checkout_path_unsafe")
	}
	fd, openErr := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if openErr != nil {
		if openErr == unix.ENOENT || openErr == unix.ENOTDIR {
			return "", "", failure("checkout_path_missing")
		}
		return "", "", failure("checkout_path_unsafe")
	}
	file := os.NewFile(uintptr(fd), path)
	defer func() { _ = file.Close() }()
	info, statErr := file.Stat()
	if statErr != nil || !info.IsDir() {
		return "", "", failure("checkout_path_unsafe")
	}
	canonical, err = directoryPath(file)
	if err != nil || hasControl(canonical) {
		return "", "", failure("checkout_path_unsafe")
	}
	current, statErr := os.Stat(canonical)
	if statErr != nil || !os.SameFile(info, current) {
		return "", "", failure("checkout_identity_changed")
	}
	identity, err = directoryIdentity(file, info)
	if err != nil {
		return "", "", failure("checkout_path_unsafe")
	}
	return canonical, identity, nil
}

func physicalWorktreeHash(rootIdentity string) string {
	return digest("bfb-physical-worktree/1\n" + rootIdentity)
}

// OpenExecutionDirectory pins the already revalidated cwd for fchdir. It grants
// no launch authority; the caller still owns policy and final online checks.
func OpenExecutionDirectory(location Location) (*os.File, error) {
	fd, err := unix.Open(location.WorkingDirectory, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, failure("checkout_identity_changed")
	}
	file := os.NewFile(uintptr(fd), "execution-working-directory")
	info, statErr := file.Stat()
	canonical, pathErr := directoryPath(file)
	identity := ""
	if statErr == nil && info.IsDir() {
		identity, err = directoryIdentity(file, info)
	}
	if statErr != nil || pathErr != nil || err != nil || canonical != location.WorkingDirectory || identity != location.CwdIdentity {
		_ = file.Close()
		return nil, failure("checkout_identity_changed")
	}
	return file, nil
}

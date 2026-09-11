// ABOUTME: Creates private per-user BFB state paths and rejects unsafe filesystem objects.
// ABOUTME: Keeps local paths out of wire diagnostics and protects state files from symlinks.

package daemon

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"
)

type Paths struct {
	Root, Cache, Logs, Database, Socket, Lock string
}

func StatePaths(directory string) (Paths, error) {
	if directory == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return Paths{}, &Failure{Code: "unsafe_state"}
		}
		directory = filepath.Join(base, "BFB")
	}
	root, err := filepath.Abs(directory)
	if err != nil {
		return Paths{}, &Failure{Code: "unsafe_state"}
	}
	home, _ := os.UserHomeDir()
	if root == string(filepath.Separator) || root == home {
		return Paths{}, &Failure{Code: "unsafe_state"}
	}
	p := Paths{Root: root, Cache: filepath.Join(root, "cache"), Logs: filepath.Join(root, "logs"), Database: filepath.Join(root, "state.sqlite"), Socket: filepath.Join(root, "daemon.sock"), Lock: filepath.Join(root, "daemon.lock")}
	// Darwin sockaddr_un has a 104-byte path, including its terminating NUL.
	if len(p.Socket) >= 104 {
		return Paths{}, &Failure{Code: "unsafe_state"}
	}
	return p, nil
}

func (p Paths) Prepare() error {
	for _, dir := range []string{p.Root, p.Cache, p.Logs} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return &Failure{Code: "unsafe_state"}
		}
		info, err := os.Lstat(dir)
		if err != nil || !info.IsDir() || !privateOwner(info) {
			return &Failure{Code: "unsafe_state"}
		}
	}
	return nil
}

func privateOwner(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Getuid()) && info.Mode().Perm()&0077 == 0
}

func privateFile(path string, flags int) (*os.File, error) {
	fd, err := unix.Open(path, flags|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, &Failure{Code: "unsafe_state"}
	}
	f := os.NewFile(uintptr(fd), path)
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || !privateOwner(info) {
		_ = f.Close()
		return nil, &Failure{Code: "unsafe_state"}
	}
	return f, nil
}

func checkOptionalFile(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || !info.Mode().IsRegular() || !privateOwner(info) {
		return &Failure{Code: "unsafe_state"}
	}
	return nil
}

type stateLock struct{ file *os.File }

func acquireLock(path string) (*stateLock, error) {
	f, err := privateFile(path, unix.O_CREAT|unix.O_RDWR)
	if err != nil {
		return nil, err
	}
	if err = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = f.Close()
		return nil, &Failure{Code: "already_running"}
	}
	return &stateLock{file: f}, nil
}

func (l *stateLock) Close() error {
	// Keep the inode: unlinking it would allow two locks on different inodes.
	return l.file.Close()
}

// ABOUTME: Supplies Linux directory identity for the repository's non-macOS verification lane.
// ABOUTME: Uses device and inode identity plus filesystem creation time when statx provides it.

package checkout

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"
)

func directoryPath(file *os.File) (string, error) {
	return filepath.EvalSymlinks(file.Name())
}

func directoryIdentity(file *os.File, info os.FileInfo) (string, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", failure("checkout_path_unsafe")
	}
	var extended unix.Statx_t
	if unix.Statx(int(file.Fd()), "", unix.AT_EMPTY_PATH, unix.STATX_BTIME, &extended) != nil {
		extended = unix.Statx_t{}
	}
	return fmt.Sprintf("linux:%d:%d:%d:%d", stat.Dev, stat.Ino, extended.Btime.Sec, extended.Btime.Nsec), nil
}

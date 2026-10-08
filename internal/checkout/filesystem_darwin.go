// ABOUTME: Reads macOS canonical directory spelling and stable APFS resource identity.
// ABOUTME: Includes inode generation and creation time to detect directory replacement or inode reuse.

package checkout

import (
	"fmt"
	"os"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

func directoryPath(file *os.File) (string, error) {
	var buffer [unix.PathMax]byte
	_, err := unix.FcntlInt(file.Fd(), unix.F_GETPATH, int(uintptr(unsafe.Pointer(&buffer[0]))))
	runtime.KeepAlive(&buffer)
	if err != nil {
		return "", err
	}
	return unix.ByteSliceToString(buffer[:]), nil
}

func directoryIdentity(_ *os.File, info os.FileInfo) (string, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", failure("checkout_path_unsafe")
	}
	return fmt.Sprintf("darwin:%d:%d:%d:%d:%d", stat.Dev, stat.Ino, stat.Gen, stat.Birthtimespec.Sec, stat.Birthtimespec.Nsec), nil
}

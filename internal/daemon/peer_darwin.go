// ABOUTME: Reads macOS Unix-socket peer credentials from the kernel.
// ABOUTME: Supplies actual UID and PID rather than trusting request-supplied identity.

package daemon

import (
	"net"

	"golang.org/x/sys/unix"
)

func socketPeer(conn *net.UnixConn) (Peer, error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return Peer{}, &Failure{Code: "peer_denied"}
	}
	var result Peer
	var inspectErr error
	err = raw.Control(func(fd uintptr) {
		credential, failure := unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
		// Darwin's sys/ucred.h defines XUCRED_VERSION as zero.
		if failure != nil || credential.Version != 0 {
			inspectErr = &Failure{Code: "peer_denied"}
			return
		}
		pid, failure := unix.GetsockoptInt(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERPID)
		if failure != nil {
			inspectErr = &Failure{Code: "peer_denied"}
			return
		}
		result = Peer{UID: int(credential.Uid), PID: pid}
	})
	if err != nil || inspectErr != nil {
		return Peer{}, &Failure{Code: "peer_denied"}
	}
	return result, nil
}

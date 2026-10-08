// ABOUTME: Reads Linux Unix-socket peer credentials for portable daemon and CI checks.
// ABOUTME: Keeps the same UID and PID authority contract as the macOS runtime.

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
		credential, failure := unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
		if failure != nil {
			inspectErr = failure
			return
		}
		result = Peer{UID: int(credential.Uid), PID: int(credential.Pid)}
	})
	if err != nil || inspectErr != nil {
		return Peer{}, &Failure{Code: "peer_denied"}
	}
	return result, nil
}

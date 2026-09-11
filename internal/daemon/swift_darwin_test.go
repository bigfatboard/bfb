// ABOUTME: Proves Swift can communicate with the daemon's real owner-only Unix socket.
// ABOUTME: Validates native-client output against the shared canonical local RPC schema.

package daemon

import (
	"context"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/protocol"
)

func TestSwiftUnixSocketClient(t *testing.T) {
	p := testPaths(t)
	s, err := Start(context.Background(), p, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	binary := filepath.Join(p.Cache, "swift-rpc-client")
	if output, err := exec.CommandContext(ctx, "swiftc", "testdata/rpc-client.swift", "-o", binary).CombinedOutput(); err != nil {
		t.Fatalf("Swift fixture build: %v %s", err, output)
	}
	output, err := exec.CommandContext(ctx, binary, p.Socket).Output()
	if err != nil {
		t.Fatal("native socket client", err)
	}
	decoded := protocol.DecodeWireDocument("local-rpc", output)
	if !decoded.OK || decoded.Value["request_id"] != "01J00000000000000000000001" {
		t.Fatalf("invalid native response: %+v", decoded.Error)
	}
}

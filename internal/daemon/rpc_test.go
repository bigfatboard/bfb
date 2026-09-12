// ABOUTME: Tests real private Unix-socket RPC, framing, peer credentials and daemon contention.
// ABOUTME: Checks malformed requests, failed handlers, cancellation and conservative lifecycle behavior.

package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/protocol/generated"
)

func TestDaemonLifecycleAndPeerIdentity(t *testing.T) {
	p := testPaths(t)
	registry := NewRegistry()
	if err := registry.Register("fixture.peer", func(_ context.Context, r Request) (map[string]any, error) {
		if r.Peer.UID != os.Getuid() || r.Peer.PID != os.Getpid() {
			t.Errorf("incorrect kernel peer: %+v", r.Peer)
		}
		return map[string]any{"status": "running"}, nil
	}); err != nil {
		t.Fatal(err)
	}
	s, err := Start(context.Background(), p, registry)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err = Start(context.Background(), p, nil); err == nil || AsFailure(err).Code != "already_running" {
		t.Fatalf("second daemon: %v", err)
	}
	for _, method := range []string{"daemon.status", "fixture.peer"} {
		result, callErr := Call(context.Background(), p, method, nil)
		if callErr != nil || result.Payload["status"] != "running" {
			t.Fatalf("%s: %v %+v", method, callErr, result)
		}
	}
	info, err := os.Lstat(p.Socket)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("socket permissions: %v", err)
	}
	if _, err = s.Store.DB.Exec("INSERT INTO process_observations VALUES ('synthetic', 123, 'synthetic-start', 'attached')"); err != nil {
		t.Fatal(err)
	}
	if _, err = Call(context.Background(), p, "daemon.stop", nil); err != nil {
		t.Fatal(err)
	}
	select {
	case <-s.Done:
	case <-time.After(5 * time.Second):
		t.Fatal("daemon failed to stop")
	}
	if _, err = os.Lstat(p.Socket); !os.IsNotExist(err) {
		t.Fatal("socket remained after shutdown")
	}
	if _, err = Call(context.Background(), p, "daemon.status", nil); err == nil {
		t.Fatal("offline status reported success")
	}
	restarted, err := Start(context.Background(), p, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	result, err := Call(context.Background(), p, "daemon.status", nil)
	if err != nil || result.Payload["recovery_pending"] != float64(1) {
		t.Fatalf("restart lost unknown process: %+v %v", result, err)
	}
}

func TestAdditionalServerAuthorizationRunsBeforeSendingPayload(t *testing.T) {
	paths := testPaths(t)
	registry := NewRegistry()
	var received atomic.Int32
	if err := registry.Register("fixture.private", func(context.Context, Request) (map[string]any, error) {
		received.Add(1)
		return map[string]any{"status": "running"}, nil
	}); err != nil {
		t.Fatal(err)
	}
	server, err := Start(context.Background(), paths, registry)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	var checked Peer
	deny := func(peer Peer) error { checked = peer; return &Failure{Code: "peer_denied"} }
	if _, err = CallWithPeerAuthorization(context.Background(), paths, "fixture.private", map[string]any{"daemon_pid": 1234}, deny); err == nil || AsFailure(err).Code != "peer_denied" {
		t.Fatal("server verification did not reject", err)
	}
	if checked != (Peer{UID: os.Getuid(), PID: os.Getpid()}) {
		t.Fatal("server verifier did not receive kernel identity")
	}
	if received.Load() != 0 {
		t.Fatal("private data sent before server authorization")
	}
	if _, err = CallWithPeerAuthorization(context.Background(), paths, "fixture.private", nil, nil); err == nil {
		t.Fatal("missing verifier accepted")
	}
	if _, err = CallWithPeerAuthorization(context.Background(), paths, "fixture.private", nil, func(peer Peer) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if received.Load() != 1 {
		t.Fatal("authorized request not delivered once")
	}
}

func TestMalformedAndOversizedFramesAreClosed(t *testing.T) {
	p := testPaths(t)
	s, err := Start(context.Background(), p, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	id := NewRequestID()
	frames := []string{
		"not json\n",
		`{"schema_version":1,"request_id":"` + id + `","method":"daemon.status","direction":"request","direction":"response"}` + "\n",
		`{"schema_version":2,"request_id":"` + id + `","method":"daemon.status","direction":"request"}` + "\n",
		`{"schema_version":1,"request_id":"` + id + `","method":"daemon.status","direction":"response"}` + "\n",
		`{"schema_version":1,"request_id":"` + id + `","method":"daemon.status","direction":"request","payload":{"prompt":"synthetic-private"}}` + "\n",
		strings.Repeat("x", MaxRPCBytes+1) + "\n",
	}
	for index, frame := range frames {
		connection, dialErr := net.Dial("unix", p.Socket)
		if dialErr != nil {
			t.Fatal(dialErr)
		}
		_ = connection.SetDeadline(time.Now().Add(time.Second))
		_, _ = connection.Write([]byte(frame))
		var one [1]byte
		n, readErr := connection.Read(one[:])
		_ = connection.Close()
		if n != 0 || readErr == nil {
			t.Fatalf("frame %d was not rejected", index)
		}
		if timeout, ok := readErr.(net.Error); ok && timeout.Timeout() {
			t.Fatalf("frame %d was not promptly closed", index)
		}
	}
	if _, err = Call(context.Background(), p, "daemon.status", nil); err != nil {
		t.Fatal("malformed input harmed daemon", err)
	}
}

func TestRPCFailureAndConcurrentClients(t *testing.T) {
	p := testPaths(t)
	registry := NewRegistry()
	_ = registry.Register("fixture.panic", func(context.Context, Request) (map[string]any, error) { panic("synthetic-secret") })
	_ = registry.Register("fixture.invalid", func(context.Context, Request) (map[string]any, error) {
		return map[string]any{"secret": "synthetic-private"}, nil
	})
	s, err := Start(context.Background(), p, registry)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, method := range []string{"fixture.panic", "fixture.invalid", "missing.method"} {
		result, callErr := Call(context.Background(), p, method, nil)
		if callErr == nil || result.Error == nil || strings.Contains(callErr.Error(), "synthetic") {
			t.Fatal("unbounded error", result, callErr)
		}
	}
	if _, err = Call(context.Background(), p, "daemon.status", map[string]any{"status": "running"}); err == nil {
		t.Fatal("accepted unexpected request payload")
	}
	var wg sync.WaitGroup
	for index := 0; index < 16; index++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, callErr := Call(context.Background(), p, "daemon.status", nil); callErr != nil {
				t.Error(callErr)
			}
		}()
	}
	wg.Wait()
	if authorizePeer(Peer{UID: os.Getuid() + 1, PID: 123}) == nil || authorizePeer(Peer{UID: os.Getuid(), PID: 0}) == nil {
		t.Fatal("accepted untrusted peer identity")
	}
}

func TestRegistryAndCanonicalIDs(t *testing.T) {
	registry := NewRegistry()
	handler := func(context.Context, Request) (map[string]any, error) { return nil, nil }
	if registry.Register("fixture.a", handler) != nil || registry.Register("fixture.a", handler) == nil || registry.Register("shell;command", handler) == nil || registry.Register("fixture.b", nil) == nil {
		t.Fatal("invalid registration boundary")
	}
	seen := map[string]bool{}
	for index := 0; index < 1000; index++ {
		id := NewRequestID()
		if !ulidPattern.MatchString(id) || seen[id] {
			t.Fatal("invalid or duplicate ID")
		}
		seen[id] = true
	}
	data, err := EncodeEnvelope(Response("daemon.status", NewRequestID(), map[string]any{"status": "running"}, nil))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = readEnvelope(bufio.NewReaderSize(strings.NewReader(string(data)), MaxRPCBytes+1)); err != nil {
		t.Fatal(err)
	}
}

func TestClientRejectsUncorrelatedReply(t *testing.T) {
	p := testPaths(t)
	listener, err := net.Listen("unix", p.Socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err = os.Chmod(p.Socket, 0600); err != nil {
		t.Fatal(err)
	}
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer connection.Close()
		_, _ = bufio.NewReader(connection).ReadString('\n')
		_ = json.NewEncoder(connection).Encode(generated.LocalRpcEnvelope{SchemaVersion: 1, RequestId: NewRequestID(), Method: "daemon.status", Direction: "response", Payload: map[string]any{"status": "running"}})
	}()
	if _, err = Call(context.Background(), p, "daemon.status", nil); err == nil || AsFailure(err).Code != "invalid_request" {
		t.Fatalf("uncorrelated reply: %v", err)
	}
}

func TestUnsafePathsAndSocketArePreserved(t *testing.T) {
	p := testPaths(t)
	if err := os.WriteFile(p.Socket, []byte("synthetic-canary"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Start(context.Background(), p, nil); err == nil {
		t.Fatal("overwrote non-socket object")
	}
	data, _ := os.ReadFile(p.Socket)
	if string(data) != "synthetic-canary" {
		t.Fatal("socket-path file changed")
	}
	link := filepath.Join(p.Root, "alias")
	if err := os.Symlink(p.Cache, link); err != nil {
		t.Fatal(err)
	}
	alias, err := StatePaths(link)
	if err != nil {
		t.Fatal(err)
	}
	if err = alias.Prepare(); err == nil {
		t.Fatal("accepted symlink state root")
	}
	if _, err = StatePaths("/"); err == nil {
		t.Fatal("accepted filesystem root")
	}
	if _, err = StatePaths(strings.Repeat("x", 110)); err == nil {
		t.Fatal("accepted overlong socket path")
	}
	if err = os.Chmod(p.Root, 0755); err != nil {
		t.Fatal(err)
	}
	if err = p.Prepare(); err == nil {
		t.Fatal("accepted public state directory")
	}
}

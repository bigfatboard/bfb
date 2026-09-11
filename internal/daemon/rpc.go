// ABOUTME: Implements bounded canonical local RPC framing and leaf-operation registration.
// ABOUTME: Correlates replies and checks kernel peer identity on both sides of the Unix socket.

package daemon

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"math/big"
	"net"
	"os"
	"regexp"
	"sort"
	"time"

	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

const MaxRPCBytes = 64 * 1024

var methodPattern = regexp.MustCompile(`^[a-z][a-z0-9_.]{0,63}$`)

type Peer struct{ UID, PID int }

type Request struct {
	Envelope generated.LocalRpcEnvelope
	Peer     Peer
}

type Handler func(context.Context, Request) (map[string]any, error)

// Registry is populated before the server starts; it is not a dynamic plugin surface.
type Registry struct{ handlers map[string]Handler }

func NewRegistry() *Registry { return &Registry{handlers: make(map[string]Handler)} }

func (r *Registry) Register(method string, handler Handler) error {
	if !methodPattern.MatchString(method) || handler == nil || r.handlers[method] != nil {
		return &Failure{Code: "invalid_request"}
	}
	r.handlers[method] = handler
	return nil
}

func (r *Registry) Methods() []string {
	methods := make([]string, 0, len(r.handlers))
	for method := range r.handlers {
		methods = append(methods, method)
	}
	sort.Strings(methods)
	return methods
}

func NewRequestID() string {
	// ULID: 48-bit Unix milliseconds followed by 80 cryptographically random bits.
	var data [16]byte
	if _, err := rand.Read(data[6:]); err != nil {
		panic("system random source unavailable")
	}
	timestamp := uint64(time.Now().UnixMilli())
	for index := 5; index >= 0; index-- {
		data[index] = byte(timestamp)
		timestamp >>= 8
	}
	value := new(big.Int).SetBytes(data[:])
	mask := big.NewInt(31)
	var encoded [26]byte
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	for index := 25; index >= 0; index-- {
		encoded[index] = alphabet[new(big.Int).And(value, mask).Int64()]
		value.Rsh(value, 5)
	}
	return string(encoded[:])
}

func Response(method, requestID string, payload map[string]any, err error) generated.LocalRpcEnvelope {
	response := generated.LocalRpcEnvelope{SchemaVersion: 1, RequestId: requestID, Method: method, Direction: "response", Payload: payload}
	if err != nil {
		response.Payload = nil
		response.Error = AsFailure(err).Diagnostic()
	}
	return response
}

func EncodeEnvelope(envelope generated.LocalRpcEnvelope) ([]byte, error) {
	data, err := json.Marshal(envelope)
	if err != nil || len(data) > MaxRPCBytes {
		return nil, &Failure{Code: "invalid_request"}
	}
	decoded := protocol.DecodeWireDocument("local-rpc", data)
	if !decoded.OK {
		return nil, &Failure{Code: "invalid_request"}
	}
	return append(data, '\n'), nil
}

func readEnvelope(reader *bufio.Reader) (generated.LocalRpcEnvelope, error) {
	data, err := reader.ReadSlice('\n')
	if err != nil {
		if err == io.EOF && len(data) == 0 {
			return generated.LocalRpcEnvelope{}, io.EOF
		}
		return generated.LocalRpcEnvelope{}, &Failure{Code: "invalid_request"}
	}
	if len(data) > MaxRPCBytes || !protocol.DecodeWireDocument("local-rpc", data).OK {
		return generated.LocalRpcEnvelope{}, &Failure{Code: "invalid_request"}
	}
	var envelope generated.LocalRpcEnvelope
	if json.Unmarshal(data, &envelope) != nil {
		return generated.LocalRpcEnvelope{}, &Failure{Code: "invalid_request"}
	}
	return envelope, nil
}

func authorizePeer(peer Peer) error {
	if peer.UID != os.Getuid() || peer.PID <= 0 {
		return &Failure{Code: "peer_denied"}
	}
	return nil
}

func Call(ctx context.Context, paths Paths, method string, payload map[string]any) (generated.LocalRpcEnvelope, error) {
	request := generated.LocalRpcEnvelope{SchemaVersion: 1, RequestId: NewRequestID(), Method: method, Direction: "request", Payload: payload}
	data, err := EncodeEnvelope(request)
	if err != nil {
		return Response(method, request.RequestId, nil, err), err
	}
	info, err := os.Lstat(paths.Root)
	if err != nil || !info.IsDir() || !privateOwner(info) {
		failure := &Failure{Code: "daemon_offline"}
		return Response(method, request.RequestId, nil, failure), failure
	}
	info, err = os.Lstat(paths.Socket)
	if err != nil || info.Mode()&os.ModeSocket == 0 || !privateOwner(info) {
		failure := &Failure{Code: "daemon_offline"}
		return Response(method, request.RequestId, nil, failure), failure
	}
	dialer := net.Dialer{Timeout: 5 * time.Second}
	connection, err := dialer.DialContext(ctx, "unix", paths.Socket)
	if err != nil {
		failure := &Failure{Code: "daemon_offline"}
		return Response(method, request.RequestId, nil, failure), failure
	}
	defer func() { _ = connection.Close() }()
	stopCancellation := context.AfterFunc(ctx, func() { _ = connection.Close() })
	defer stopCancellation()
	peer, err := socketPeer(connection.(*net.UnixConn))
	if err != nil || authorizePeer(peer) != nil {
		failure := &Failure{Code: "peer_denied"}
		return Response(method, request.RequestId, nil, failure), failure
	}
	deadline := time.Now().Add(10 * time.Second)
	if until, ok := ctx.Deadline(); ok && until.Before(deadline) {
		deadline = until
	}
	_ = connection.SetDeadline(deadline)
	if _, err = connection.Write(data); err != nil {
		failure := &Failure{Code: "daemon_offline"}
		return Response(method, request.RequestId, nil, failure), failure
	}
	response, err := readEnvelope(bufio.NewReaderSize(connection, MaxRPCBytes+1))
	if err != nil || response.Direction != "response" || response.RequestId != request.RequestId || response.Method != method {
		failure := &Failure{Code: "invalid_request"}
		return Response(method, request.RequestId, nil, failure), failure
	}
	if response.Error != nil {
		failure := &Failure{Code: response.Error.Code}
		return Response(method, request.RequestId, nil, failure), failure
	}
	return response, nil
}

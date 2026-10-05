// ABOUTME: Implements bounded canonical local RPC framing and leaf-operation registration.
// ABOUTME: Correlates replies and checks kernel peer identity on both sides of the Unix socket.

package daemon

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net"
	"os"
	"regexp"
	"sort"
	"strings"
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
	Store    *Store
}

type Handler func(context.Context, Request) (map[string]any, error)

// Registry is populated before the server starts; it is not a dynamic plugin surface.
type Registry struct {
	handlers map[string]Handler
	services map[string]Service
}

// Service starts with the daemon-owned database and returns a joining shutdown.
// Shutdown runs before SQLite closes, including a partial startup failure.
type Service func(context.Context, *Store) (func(), error)

func NewRegistry() *Registry {
	return &Registry{handlers: make(map[string]Handler), services: make(map[string]Service)}
}

func (r *Registry) RegisterService(name string, start Service) error {
	if !methodPattern.MatchString(name) || start == nil || r.services[name] != nil {
		return &Failure{Code: "invalid_request"}
	}
	r.services[name] = start
	return nil
}

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
	return ResponseVersion(1, method, requestID, payload, err)
}

func ResponseVersion(version int64, method, requestID string, payload map[string]any, err error) generated.LocalRpcEnvelope {
	response := generated.LocalRpcEnvelope{SchemaVersion: version, RequestId: requestID, Method: method, Direction: "response", Payload: payload}
	if err != nil {
		response.Payload = nil
		response.Error = AsFailure(err).Diagnostic()
	}
	return response
}

func EncodeEnvelope(envelope generated.LocalRpcEnvelope) ([]byte, error) {
	data, err := json.Marshal(envelope)
	if err != nil || len(data)+1 > MaxRPCBytes {
		return nil, &Failure{Code: "invalid_request"}
	}
	if !decodeEnvelope(data).OK {
		return nil, &Failure{Code: "invalid_request"}
	}
	return append(data, '\n'), nil
}

func readEnvelope(reader *bufio.Reader) (generated.LocalRpcEnvelope, error) {
	return readEnvelopeContext(nil, reader)
}

// Only the attention caller supplies its bounded context. An interrupted read
// is not a malformed request; decoded authority denials retain their own code.
func readEnvelopeContext(ctx context.Context, reader *bufio.Reader) (generated.LocalRpcEnvelope, error) {
	data, err := reader.ReadSlice('\n')
	if err != nil {
		if ctx != nil {
			if cancellation := ctx.Err(); cancellation != nil {
				return generated.LocalRpcEnvelope{}, cancellation
			}
			// A socket deadline can fire just before the context timer is scheduled.
			var networkError net.Error
			if deadline, bounded := ctx.Deadline(); bounded && !time.Now().Before(deadline) && errors.As(err, &networkError) && networkError.Timeout() {
				return generated.LocalRpcEnvelope{}, context.DeadlineExceeded
			}
			if errors.As(err, &networkError) || (err == io.EOF && len(data) == 0) {
				return generated.LocalRpcEnvelope{}, &Failure{Code: "daemon_offline"}
			}
		}
		if err == io.EOF && len(data) == 0 {
			return generated.LocalRpcEnvelope{}, io.EOF
		}
		return generated.LocalRpcEnvelope{}, &Failure{Code: "invalid_request"}
	}
	decoded := decodeEnvelope(data)
	if len(data) > MaxRPCBytes || !decoded.OK {
		return generated.LocalRpcEnvelope{}, &Failure{Code: "invalid_request"}
	}
	var envelope generated.LocalRpcEnvelope
	if json.Unmarshal([]byte(decoded.JSON), &envelope) != nil {
		return generated.LocalRpcEnvelope{}, &Failure{Code: "invalid_request"}
	}
	return envelope, nil
}

func decodeEnvelope(data []byte) protocol.DecodeResult {
	decoded := protocol.DecodeWireDocument("local-rpc", data)
	if decoded.OK && !strings.HasPrefix(decoded.Value["method"].(string), "mcp.v2.") && !strings.HasPrefix(decoded.Value["method"].(string), "mcp.v3.") && !strings.HasPrefix(decoded.Value["method"].(string), "mcp.v4.") {
		return decoded
	}
	if decoded = protocol.DecodeWireDocument("local-agent-rpc", data); decoded.OK {
		return decoded
	}
	if decoded = protocol.DecodeWireDocument("local-agent-work-rpc", data); decoded.OK {
		return decoded
	}
	return protocol.DecodeWireDocument("local-agent-attention-rpc", data)
}

func authorizePeer(peer Peer) error {
	if peer.UID != os.Getuid() || peer.PID <= 0 {
		return &Failure{Code: "peer_denied"}
	}
	return nil
}

func Call(ctx context.Context, paths Paths, method string, payload map[string]any) (generated.LocalRpcEnvelope, error) {
	return call(ctx, paths, 1, method, payload, nil)
}

// CallWithPeerAuthorization checks an additional native server identity before
// sending private execution data. The callback receives only kernel peer facts.
func CallWithPeerAuthorization(ctx context.Context, paths Paths, method string, payload map[string]any, authorize func(Peer) error) (generated.LocalRpcEnvelope, error) {
	if authorize == nil {
		return generated.LocalRpcEnvelope{}, &Failure{Code: "peer_denied"}
	}
	return call(ctx, paths, 1, method, payload, authorize)
}

// CallAgent negotiates the fixed v2 lane before sending private execution input.
// Negotiation is repeated for each call; no daemon replacement inherits a cache.
func CallAgent(ctx context.Context, paths Paths, method string, payload map[string]any) (generated.LocalRpcEnvelope, error) {
	if !strings.HasPrefix(method, "mcp.v2.") {
		return generated.LocalRpcEnvelope{}, &Failure{Code: "protocol_unsupported"}
	}
	return call(ctx, paths, 2, method, payload, nil)
}

// CallAgentWork negotiates the closed write/receipt lane on the same checked
// socket. An older daemon is unsupported; private input never falls back to v2.
func CallAgentWork(ctx context.Context, paths Paths, method string, payload map[string]any) (generated.LocalRpcEnvelope, error) {
	switch method {
	case "mcp.v3.add_comment", "mcp.v3.update_task", "mcp.v3.report_progress", "mcp.v3.propose_task":
		return call(ctx, paths, 3, method, payload, nil)
	default:
		return generated.LocalRpcEnvelope{}, &Failure{Code: "protocol_unsupported"}
	}
}

// CallAgentAttention negotiates only the online attention lane on the same
// checked peer. It never falls back to a task-write or legacy envelope.
func CallAgentAttention(ctx context.Context, paths Paths, method string, payload map[string]any) (generated.LocalRpcEnvelope, error) {
	switch method {
	case "mcp.v4.request_human", "mcp.v4.get_attention":
		return call(ctx, paths, 4, method, payload, nil)
	default:
		return generated.LocalRpcEnvelope{}, &Failure{Code: "protocol_unsupported"}
	}
}

func call(ctx context.Context, paths Paths, version int64, method string, payload map[string]any, extraAuthorization func(Peer) error) (generated.LocalRpcEnvelope, error) {
	request := generated.LocalRpcEnvelope{SchemaVersion: version, RequestId: NewRequestID(), Method: method, Direction: "request", Payload: payload}
	data, err := EncodeEnvelope(request)
	if err != nil {
		return ResponseVersion(version, method, request.RequestId, nil, err), err
	}
	info, err := os.Lstat(paths.Root)
	if err != nil || !info.IsDir() || !privateOwner(info) {
		failure := &Failure{Code: "daemon_offline"}
		return ResponseVersion(version, method, request.RequestId, nil, failure), failure
	}
	info, err = os.Lstat(paths.Socket)
	if err != nil || info.Mode()&os.ModeSocket == 0 || !privateOwner(info) {
		failure := &Failure{Code: "daemon_offline"}
		return ResponseVersion(version, method, request.RequestId, nil, failure), failure
	}
	dialer := net.Dialer{Timeout: 5 * time.Second}
	connection, err := dialer.DialContext(ctx, "unix", paths.Socket)
	if err != nil {
		failure := &Failure{Code: "daemon_offline"}
		return ResponseVersion(version, method, request.RequestId, nil, failure), failure
	}
	defer func() { _ = connection.Close() }()
	stopCancellation := context.AfterFunc(ctx, func() { _ = connection.Close() })
	defer stopCancellation()
	peer, err := socketPeer(connection.(*net.UnixConn))
	if err != nil || authorizePeer(peer) != nil {
		failure := &Failure{Code: "peer_denied"}
		return ResponseVersion(version, method, request.RequestId, nil, failure), failure
	}
	if extraAuthorization != nil && extraAuthorization(peer) != nil {
		failure := &Failure{Code: "peer_denied"}
		return ResponseVersion(version, method, request.RequestId, nil, failure), failure
	}
	deadline := time.Now().Add(10 * time.Second)
	if until, ok := ctx.Deadline(); ok && until.Before(deadline) {
		deadline = until
	}
	_ = connection.SetDeadline(deadline)
	if version == 2 || version == 3 || version == 4 {
		// Keep negotiation and the private request on the same checked kernel peer.
		status := generated.LocalRpcEnvelope{SchemaVersion: 1, RequestId: NewRequestID(), Method: "daemon.status", Direction: "request"}
		statusData, encodeErr := EncodeEnvelope(status)
		if encodeErr != nil {
			return ResponseVersion(version, method, request.RequestId, nil, encodeErr), encodeErr
		}
		if _, err = connection.Write(statusData); err != nil {
			failure := &Failure{Code: "daemon_offline"}
			return ResponseVersion(version, method, request.RequestId, nil, failure), failure
		}
		var readContext context.Context
		if version == 4 {
			readContext = ctx
		}
		advertised, readErr := readEnvelopeContext(readContext, bufio.NewReaderSize(connection, MaxRPCBytes+1))
		if errors.Is(readErr, context.Canceled) || errors.Is(readErr, context.DeadlineExceeded) {
			return ResponseVersion(version, method, request.RequestId, nil, readErr), readErr
		}
		if version == 4 && AsFailure(readErr).Code == "daemon_offline" {
			return ResponseVersion(version, method, request.RequestId, nil, readErr), readErr
		}
		if readErr != nil || advertised.SchemaVersion != 1 || advertised.Method != status.Method || advertised.RequestId != status.RequestId || advertised.Direction != "response" || advertised.Error != nil {
			failure := &Failure{Code: "protocol_unsupported"}
			return ResponseVersion(version, method, request.RequestId, nil, failure), failure
		}
		encodedMethods, _ := json.Marshal(advertised.Payload["methods"])
		var methods []string
		supported := false
		if json.Unmarshal(encodedMethods, &methods) == nil {
			for _, advertisedMethod := range methods {
				if advertisedMethod == method {
					supported = true
				}
			}
		}
		if !supported {
			failure := &Failure{Code: "protocol_unsupported"}
			return ResponseVersion(version, method, request.RequestId, nil, failure), failure
		}
	}
	if _, err = connection.Write(data); err != nil {
		failure := &Failure{Code: "daemon_offline"}
		return ResponseVersion(version, method, request.RequestId, nil, failure), failure
	}
	var readContext context.Context
	if version == 4 {
		readContext = ctx
	}
	response, err := readEnvelopeContext(readContext, bufio.NewReaderSize(connection, MaxRPCBytes+1))
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return ResponseVersion(version, method, request.RequestId, nil, err), err
	}
	if version == 4 && AsFailure(err).Code == "daemon_offline" {
		return ResponseVersion(version, method, request.RequestId, nil, err), err
	}
	if err != nil || response.SchemaVersion != request.SchemaVersion || response.Direction != "response" || response.RequestId != request.RequestId || response.Method != method {
		failure := &Failure{Code: "invalid_request"}
		return ResponseVersion(version, method, request.RequestId, nil, failure), failure
	}
	if response.Error != nil {
		failure := &Failure{Code: response.Error.Code}
		return ResponseVersion(version, method, request.RequestId, nil, failure), failure
	}
	return response, nil
}

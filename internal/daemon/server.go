// ABOUTME: Runs one private daemon instance with bounded local clients and durable recovery state.
// ABOUTME: Owns socket, lock and storage lifecycle and reports conservative status across restarts.

package daemon

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"os"
	"sync"
	"time"
)

type Server struct {
	Paths      Paths
	Store      *Store
	Logger     *Logger
	Done       chan struct{}
	registry   *Registry
	listener   *net.UnixListener
	lock       *stateLock
	stop       context.CancelFunc
	started    string
	socketInfo os.FileInfo
	workers    sync.WaitGroup
}

func Start(ctx context.Context, paths Paths, extensions *Registry) (*Server, error) {
	if err := paths.Prepare(); err != nil {
		return nil, err
	}
	lock, err := acquireLock(paths.Lock)
	if err != nil {
		return nil, err
	}
	store, err := OpenStore(ctx, paths)
	if err != nil {
		_ = lock.Close()
		return nil, err
	}
	s := &Server{Paths: paths, Store: store, Logger: NewLogger(paths), Done: make(chan struct{}), registry: NewRegistry(), lock: lock, started: time.Now().UTC().Format(time.RFC3339Nano)}
	if err = s.register(extensions); err != nil {
		_ = store.Close()
		_ = lock.Close()
		return nil, err
	}
	if info, statErr := os.Lstat(paths.Socket); statErr == nil {
		if info.Mode()&os.ModeSocket == 0 || !privateOwner(info) {
			err = &Failure{Code: "unsafe_state"}
		} else {
			err = os.Remove(paths.Socket)
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		err = statErr
	}
	if err == nil {
		s.listener, err = net.ListenUnix("unix", &net.UnixAddr{Name: paths.Socket, Net: "unix"})
	}
	if err == nil {
		s.listener.SetUnlinkOnClose(false)
		err = os.Chmod(paths.Socket, 0600)
	}
	if err == nil {
		s.socketInfo, err = os.Lstat(paths.Socket)
	}
	if err == nil {
		err = s.Logger.Record(LogEvent{Event: "daemon_started"})
	}
	if err != nil {
		if s.listener != nil {
			_ = s.listener.Close()
		}
		_ = store.Close()
		_ = lock.Close()
		return nil, AsFailure(err)
	}
	runContext, stop := context.WithCancel(ctx)
	s.stop = stop
	go s.serve(runContext)
	return s, nil
}

func (s *Server) register(extensions *Registry) error {
	_ = s.registry.Register("daemon.status", func(ctx context.Context, request Request) (map[string]any, error) {
		if len(request.Envelope.Payload) != 0 {
			return nil, &Failure{Code: "invalid_request"}
		}
		pending, err := s.Store.RecoveryPending(ctx)
		return map[string]any{"status": "running", "daemon_pid": os.Getpid(), "started_at": s.started, "storage_version": StorageVersion, "recovery_pending": pending}, err
	})
	_ = s.registry.Register("daemon.stop", func(_ context.Context, request Request) (map[string]any, error) {
		if len(request.Envelope.Payload) != 0 {
			return nil, &Failure{Code: "invalid_request"}
		}
		return map[string]any{"status": "stopping"}, nil
	})
	if extensions != nil {
		for name, handler := range extensions.handlers {
			if err := s.registry.Register(name, handler); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Server) Close() { s.stop(); <-s.Done }

func (s *Server) serve(ctx context.Context) {
	go func() { <-ctx.Done(); _ = s.listener.Close() }()
	seats := make(chan struct{}, 32)
	for {
		conn, err := s.listener.AcceptUnix()
		if err != nil {
			break
		}
		select {
		case seats <- struct{}{}:
			s.workers.Add(1)
			go func() {
				defer s.workers.Done()
				defer func() { <-seats }()
				s.handle(ctx, conn)
			}()
		default:
			_ = conn.Close()
		}
	}
	s.stop()
	s.workers.Wait()
	_ = s.Logger.Record(LogEvent{Event: "daemon_stopped"})
	_ = s.Store.Close()
	if current, err := os.Lstat(s.Paths.Socket); err == nil && os.SameFile(current, s.socketInfo) {
		_ = os.Remove(s.Paths.Socket)
	}
	_ = s.lock.Close()
	close(s.Done)
}

func (s *Server) handle(ctx context.Context, connection *net.UnixConn) {
	defer func() { _ = connection.Close() }()
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case <-ctx.Done():
			_ = connection.Close()
		case <-finished:
		}
	}()
	peer, err := socketPeer(connection)
	if err != nil || authorizePeer(peer) != nil {
		_ = s.Logger.Record(LogEvent{Event: "rpc_rejected", Code: "peer_denied"})
		return
	}
	reader := bufio.NewReaderSize(connection, MaxRPCBytes+1)
	for {
		_ = connection.SetDeadline(time.Now().Add(10 * time.Second))
		request, err := readEnvelope(reader)
		if errors.Is(err, io.EOF) {
			return
		}
		if err != nil || request.Direction != "request" || request.Error != nil {
			_ = s.Logger.Record(LogEvent{Event: "rpc_rejected", Code: "invalid_request"})
			return
		}
		var payload map[string]any
		if handler := s.registry.handlers[request.Method]; handler != nil {
			requestContext, cancel := context.WithTimeout(ctx, 10*time.Second)
			payload, err = invokeHandler(requestContext, handler, Request{Envelope: request, Peer: peer})
			cancel()
		} else {
			err = &Failure{Code: "unknown_method"}
		}
		response := Response(request.Method, request.RequestId, payload, err)
		data, encodeErr := EncodeEnvelope(response)
		if encodeErr != nil {
			err = &Failure{Code: "internal_error"}
			data, _ = EncodeEnvelope(Response(request.Method, request.RequestId, nil, err))
		}
		if err != nil {
			_ = s.Logger.Record(LogEvent{Event: "rpc_failed", Code: AsFailure(err).Diagnostic().Code, RequestID: request.RequestId})
		}
		if _, writeErr := connection.Write(data); writeErr != nil {
			return
		}
		if request.Method == "daemon.stop" && err == nil {
			s.stop()
			return
		}
	}
}

func invokeHandler(ctx context.Context, handler Handler, request Request) (payload map[string]any, err error) {
	defer func() {
		if recover() != nil {
			payload, err = nil, &Failure{Code: "internal_error"}
		}
	}()
	return handler(ctx, request)
}

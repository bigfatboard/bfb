// ABOUTME: Delivers bounded native UI actions without claiming cloud commands or creating execution intents.
// ABOUTME: Correlates app acknowledgements and preserves ambiguous Terminal delivery for the launch supervisor.

package appbridge

import (
	"context"
	"regexp"
	"sync"
	"time"

	"github.com/qdis/bfb/internal/daemon"
)

var ulidPattern = regexp.MustCompile(`^[0-7][0-9A-HJKMNP-TV-Z]{25}$`)
var terminalPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type Options struct {
	// WakeIntent is supplied by the launch owner; receiving a link is not authorization.
	WakeIntent    func(context.Context, string) error
	WakeApp       func(context.Context) error
	AuthorizePeer func(daemon.Peer) error
}

type delivery struct {
	id, action, reference string
	pid                   int
	offered               bool
	result                chan string
}

type acknowledgement struct {
	pid    int
	result string
}

type Bridge struct {
	options Options
	mu      sync.Mutex
	running bool
	changed chan struct{}
	pending []*delivery
	// The bounded acknowledgement cache tolerates a lost RPC response, not a new UI action.
	completed map[string]acknowledgement
	order     []string
	state     string
	lastPoll  time.Time
	appPID    int
}

// Status is an observation of the app's most recent authenticated poll, never execution activity.
type Status struct {
	State    string
	PID      int
	LastPoll time.Time
}

func (b *Bridge) Status() Status {
	b.mu.Lock()
	defer b.mu.Unlock()
	return Status{State: b.state, PID: b.appPID, LastPoll: b.lastPoll}
}

func New(options Options) *Bridge {
	if options.WakeApp == nil {
		options.WakeApp = wakeInstalledApp
	}
	if options.AuthorizePeer == nil {
		options.AuthorizePeer = authorizeApp
	}
	return &Bridge{options: options, changed: make(chan struct{}), completed: make(map[string]acknowledgement)}
}

func (b *Bridge) signal() { close(b.changed); b.changed = make(chan struct{}) }

func (b *Bridge) Start(_ context.Context, _ *daemon.Store) (func(), error) {
	b.mu.Lock()
	b.running = true
	b.mu.Unlock()
	return func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		b.running = false
		b.signal()
	}, nil
}

// OpenTerminal accepts only the supervisor's local single-use UUID, never a URL or launch specification.
func (b *Bridge) OpenTerminal(ctx context.Context, terminalIntentID string) error {
	if !terminalPattern.MatchString(terminalIntentID) {
		return &daemon.Failure{Code: "invalid_request"}
	}
	return b.deliver(ctx, "open_terminal", terminalIntentID)
}

// NotifyAttention contains no task body, response content, credentials or executable action.
func (b *Bridge) NotifyAttention(ctx context.Context, notificationID string) error {
	if !ulidPattern.MatchString(notificationID) {
		return &daemon.Failure{Code: "invalid_request"}
	}
	return b.deliver(ctx, "notify_attention", notificationID)
}

func (b *Bridge) deliver(ctx context.Context, action, reference string) error {
	ctx, cancel := context.WithTimeout(ctx, 7*time.Second)
	defer cancel()
	b.mu.Lock()
	if !b.running || len(b.pending) >= 32 {
		b.mu.Unlock()
		return &daemon.Failure{Code: "app_unavailable"}
	}
	if b.state == "locked" && time.Since(b.lastPoll) < 5*time.Second {
		b.mu.Unlock()
		return &daemon.Failure{Code: "session_locked"}
	}
	b.mu.Unlock()
	if err := b.options.WakeApp(ctx); err != nil {
		return err
	}
	d := &delivery{id: daemon.NewRequestID(), action: action, reference: reference, result: make(chan string, 1)}
	b.mu.Lock()
	if !b.running || len(b.pending) >= 32 || ctx.Err() != nil {
		b.mu.Unlock()
		return &daemon.Failure{Code: "app_unavailable"}
	}
	b.pending = append(b.pending, d)
	b.signal()
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		for index, pending := range b.pending {
			if pending == d {
				b.pending = append(b.pending[:index], b.pending[index+1:]...)
				break
			}
		}
	}()
	for {
		b.mu.Lock()
		running, offered, changed := b.running, d.offered, b.changed
		b.mu.Unlock()
		select {
		case result := <-d.result:
			return outcome(result)
		default:
		}
		if !running || ctx.Err() != nil {
			if offered {
				return &daemon.Failure{Code: "app_delivery_unknown"}
			}
			return &daemon.Failure{Code: "app_unavailable"}
		}
		select {
		case result := <-d.result:
			return outcome(result)
		case <-ctx.Done():
		case <-changed:
		}
	}
}

func outcome(result string) error {
	switch result {
	case "terminal_opened", "notification_delivered":
		return nil
	case "notification_denied", "consent_denied", "session_locked", "app_unavailable", "app_delivery_unknown", "expired_intent":
		return &daemon.Failure{Code: result}
	case "revoked":
		return &daemon.Failure{Code: "runner_revoked"}
	default:
		return &daemon.Failure{Code: "invalid_request"}
	}
}

func (b *Bridge) poll(ctx context.Context, peer daemon.Peer, state string) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	for {
		b.mu.Lock()
		if !b.running {
			b.mu.Unlock()
			return nil, &daemon.Failure{Code: "app_unavailable"}
		}
		b.state, b.lastPoll, b.appPID = state, time.Now(), peer.PID
		for _, d := range b.pending {
			if d.offered {
				continue
			}
			if state != "available" {
				result := "app_unavailable"
				if state == "locked" {
					result = "session_locked"
				}
				d.offered = true
				d.result <- result
				b.signal()
				continue
			}
			d.offered, d.pid = true, peer.PID
			payload := map[string]any{"app_delivery_id": d.id, "app_action": d.action}
			if d.action == "open_terminal" {
				payload["terminal_intent_id"] = d.reference
			} else {
				payload["notification_id"] = d.reference
			}
			b.mu.Unlock()
			return payload, nil
		}
		changed := b.changed
		b.mu.Unlock()
		select {
		case <-ctx.Done():
			return map[string]any{}, nil
		case <-changed:
		}
	}
}

func (b *Bridge) complete(peer daemon.Peer, id, result string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if previous, ok := b.completed[id]; ok {
		if previous.result == result && previous.pid == peer.PID {
			return nil
		}
		return &daemon.Failure{Code: "invalid_request"}
	}
	for _, d := range b.pending {
		if d.id != id || !d.offered || d.pid != peer.PID {
			continue
		}
		if (result == "terminal_opened" && d.action != "open_terminal") || (result == "notification_delivered" && d.action != "notify_attention") {
			return &daemon.Failure{Code: "invalid_request"}
		}
		if result == "" || (outcome(result) != nil && daemon.AsFailure(outcome(result)).Code == "invalid_request") {
			return &daemon.Failure{Code: "invalid_request"}
		}
		d.result <- result
		b.completed[id] = acknowledgement{pid: peer.PID, result: result}
		b.order = append(b.order, id)
		if len(b.order) > 256 {
			delete(b.completed, b.order[0])
			b.order = b.order[1:]
		}
		return nil
	}
	return &daemon.Failure{Code: "expired_intent"}
}

func RegisterRPC(registry *daemon.Registry, bridge *Bridge) error {
	if err := registry.RegisterService("app.bridge", bridge.Start); err != nil {
		return err
	}
	for _, method := range []string{"app.wake", "app.poll", "app.complete"} {
		if err := registry.Register(method, func(ctx context.Context, request daemon.Request) (map[string]any, error) {
			if err := bridge.options.AuthorizePeer(request.Peer); err != nil {
				return nil, err
			}
			payload := request.Envelope.Payload
			switch method {
			case "app.wake":
				id, _ := payload["wake_intent_id"].(string)
				if len(payload) != 1 || !ulidPattern.MatchString(id) {
					return nil, &daemon.Failure{Code: "invalid_request"}
				}
				if bridge.options.WakeIntent == nil {
					return nil, &daemon.Failure{Code: "not_implemented"}
				}
				return map[string]any{}, bridge.options.WakeIntent(ctx, id)
			case "app.poll":
				state, _ := payload["app_session_state"].(string)
				if len(payload) != 1 || (state != "available" && state != "locked" && state != "login_window") {
					return nil, &daemon.Failure{Code: "invalid_request"}
				}
				return bridge.poll(ctx, request.Peer, state)
			case "app.complete":
				id, _ := payload["app_delivery_id"].(string)
				result, _ := payload["app_result"].(string)
				if len(payload) != 2 || !ulidPattern.MatchString(id) {
					return nil, &daemon.Failure{Code: "invalid_request"}
				}
				return map[string]any{}, bridge.complete(request.Peer, id, result)
			}
			return nil, &daemon.Failure{Code: "invalid_request"}
		}); err != nil {
			return err
		}
	}
	return nil
}

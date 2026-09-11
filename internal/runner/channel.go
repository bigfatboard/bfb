// ABOUTME: Recovers durable commands and inventory over one isolated authenticated runner channel.
// ABOUTME: Treats heartbeat as connectivity only and fences revoked or stale sessions before retry.

package runner

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/coder/websocket"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

var errRotate = errors.New("fresh runner credential required")

type InventorySource func(context.Context, Enrollment, []string, time.Duration) ([]byte, error)

type channelRead struct {
	data []byte
	err  error
}

func (manager *Manager) serveChannel(parent context.Context, enrollment Enrollment, connection *Connection) (outcome error) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	socket, err := connection.Open(ctx)
	if err != nil {
		return err
	}
	// Read independently of in-flight HTTPS requests. An authorization change can
	// deny that request before its typed socket fence reaches the main loop.
	readCtx, stopRead := context.WithCancel(parent)
	claims := connection.snapshotClaims()
	reads := make(chan channelRead, 8)
	fences := make(chan generated.RunnerChannelClose, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			kind, data, err := socket.Read(readCtx)
			if err == nil && kind != websocket.MessageText {
				err = ErrProtocol
			}
			if err == nil && protocol.DecodeWireDocument("runner-channel-close", data).OK {
				var signal generated.RunnerChannelClose
				if json.Unmarshal(data, &signal) != nil || signal.WorkspaceId != enrollment.WorkspaceID || signal.RunnerId != enrollment.RunnerID || !claims.advancesFence(signal) {
					err = ErrProtocol
				} else {
					fences <- signal
					cancel()
					return
				}
			}
			select {
			case reads <- channelRead{data, err}:
			case <-readCtx.Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()
	defer func() {
		// A denial and its fence travel on different transports. Leave a bounded
		// window for the authenticated notice; never infer revocation from 403.
		if errors.Is(outcome, ErrAuthorization) && parent.Err() == nil {
			timer := time.NewTimer(time.Second)
			select {
			case <-done:
			case <-parent.Done():
			case <-timer.C:
			}
			timer.Stop()
		}
		cancel()
		stopRead()
		_ = socket.CloseNow()
		<-done
		select {
		case signal := <-fences:
			if signal.Reason != "revoked" {
				outcome = errRotate
				return
			}
			// Persist the verified terminal fence even if it canceled the request
			// context. Startup then stays revoked if credential cleanup is interrupted.
			cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
			defer stop()
			if err := manager.store.SetState(cleanup, enrollment.RunnerID, "revoked"); err != nil {
				outcome = err
				return
			}
			if err := connection.Revoke(cleanup); err != nil {
				outcome = err
				return
			}
			outcome = ErrRevoked
		default:
		}
	}()
	readyTimer := time.NewTimer(10 * time.Second)
	defer readyTimer.Stop()
	heartbeat := time.NewTicker(manager.heartbeat)
	defer heartbeat.Stop()
	_, due := connection.Credential()
	rotation := time.NewTimer(time.Until(due.Add(-30 * time.Second)))
	defer rotation.Stop()
	var current generated.RunnerChannelMessage
	var offset time.Duration
	var lastAlive time.Time
	var lastSync time.Time
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-rotation.C:
			return errRotate
		case <-readyTimer.C:
			return ErrOffline
		case result := <-reads:
			if result.err != nil {
				if errors.Is(result.err, ErrProtocol) {
					return ErrProtocol
				}
				return ErrOffline
			}
			if !protocol.DecodeWireDocument("runner-channel-message", result.data).OK {
				return ErrProtocol
			}
			var message generated.RunnerChannelMessage
			if json.Unmarshal(result.data, &message) != nil || message.WorkspaceId != enrollment.WorkspaceID || message.RunnerId != enrollment.RunnerID {
				return ErrProtocol
			}
			if current.ConnectionId == "" {
				if message.Kind != "runner.channel.ready" {
					return ErrProtocol
				}
				readyTimer.Stop()
			} else if message.ConnectionId != current.ConnectionId || message.Kind == "runner.channel.ready" {
				return ErrProtocol
			}
			switch message.Kind {
			case "runner.channel.ready", "runner.channel.alive":
				epoch, _ := connection.Credential()
				if message.TokenEpoch == nil || *message.TokenEpoch != epoch || message.AuthExpiresAt == nil || message.ServerTime == nil {
					return ErrProtocol
				}
				serverNow, err := time.Parse(time.RFC3339Nano, *message.ServerTime)
				if err != nil {
					return ErrProtocol
				}
				expiry, _ := time.Parse(time.RFC3339Nano, *message.AuthExpiresAt)
				if !expiry.After(serverNow) || expiry.Sub(serverNow) > 5*time.Minute {
					return ErrProtocol
				}
				lastAlive = time.Now()
				offset = serverNow.Sub(lastAlive)
				current = message
				if err := manager.store.SetState(ctx, enrollment.RunnerID, "online"); err != nil {
					return err
				}
			case "runner.commands.available":
			default:
				return ErrProtocol
			}
			if message.Kind != "runner.channel.alive" {
				if err := manager.pull(ctx, enrollment, connection); err != nil {
					return err
				}
			}
			if time.Since(lastSync) >= manager.heartbeat {
				if err := manager.syncInventory(ctx, enrollment, connection, current.ProjectIds, offset); err != nil {
					return err
				}
				lastSync = time.Now()
			}
		case <-heartbeat.C:
			if current.ConnectionId == "" {
				continue
			}
			if time.Since(lastAlive) > 45*time.Second {
				return ErrOffline
			}
			data, _ := json.Marshal(generated.RunnerChannelMessage{SchemaVersion: 1, Kind: "runner.channel.heartbeat", WorkspaceId: enrollment.WorkspaceID, RunnerId: enrollment.RunnerID, ConnectionId: current.ConnectionId})
			writeCtx, stop := context.WithTimeout(ctx, 5*time.Second)
			err := socket.Write(writeCtx, websocket.MessageText, data)
			stop()
			if err != nil {
				return ErrOffline
			}
			// Periodic pull does not depend on receiving a nudge or an alive reply.
			if err := manager.pull(ctx, enrollment, connection); err != nil {
				return err
			}
		}
	}
}

func (manager *Manager) pull(ctx context.Context, enrollment Enrollment, connection RunnerConnection) error {
	after := ""
	for pageIndex := 0; pageIndex < 16; pageIndex++ {
		request := map[string]string{}
		if after != "" {
			request["after_command_id"] = after
		}
		body, _ := json.Marshal(request)
		data, err := connection.Request(ctx, "POST", "commands/pull", body)
		if err != nil {
			return err
		}
		var page struct {
			Version     int                `json:"schema_version"`
			WorkspaceID string             `json:"workspace_id"`
			RunnerID    string             `json:"runner_id"`
			Commands    []CommandReference `json:"commands"`
			More        bool               `json:"more"`
			Next        string             `json:"next_command_id,omitempty"`
		}
		if !protocol.DecodeWireDocument("runner-command-pull", data).OK || strictJSON(data, &page) != nil || page.WorkspaceID != enrollment.WorkspaceID || page.RunnerID != enrollment.RunnerID {
			return ErrProtocol
		}
		for _, command := range page.Commands {
			if command.ID <= after {
				return ErrProtocol
			}
			after = command.ID
		}
		if (page.More && (len(page.Commands) != 25 || page.Next != after)) || (!page.More && page.Next != "") {
			return ErrProtocol
		}
		if err := manager.store.Receive(ctx, enrollment.RunnerID, page.Commands); err != nil {
			return err
		}
		if err := manager.store.Deliver(ctx, enrollment, manager.consumers); err != nil {
			return err
		}
		if !page.More {
			return nil
		}
	}
	return ErrProtocol
}

func (manager *Manager) syncInventory(ctx context.Context, enrollment Enrollment, connection RunnerConnection, projects []string, offset time.Duration) error {
	data, err := manager.inventory(ctx, enrollment, projects, offset)
	if err != nil {
		return err
	}
	if len(data) > 49152 || !protocol.DecodeWireDocument("runner-inventory", data).OK {
		return ErrProtocol
	}
	_, err = connection.Request(ctx, "POST", "inventory", data)
	return err
}

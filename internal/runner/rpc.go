// ABOUTME: Exposes enrollment initiation, status, wake and revoked-identity removal over private local RPC.
// ABOUTME: Returns public browser handoff data only and never accepts remote signing inputs or credentials.

package runner

import (
	"context"
	"errors"

	"github.com/qdis/bfb/internal/auth"
	"github.com/qdis/bfb/internal/daemon"
)

func (manager *Manager) Enroll(ctx context.Context, origin, workspace, label string) (Enrollment, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.store == nil || manager.ctx.Err() != nil {
		return Enrollment{}, ErrOffline
	}
	enrollment, err := manager.store.Begin(ctx, origin, workspace, label)
	if err != nil {
		return Enrollment{}, err
	}
	if len(enrollment.PublicKey) == 0 && manager.workers[enrollment.RunnerID] != nil {
		return Enrollment{}, auth.ErrCredentialUnavailable
	}
	enrollment, err = manager.store.CompleteKey(ctx, enrollment, manager.credentials)
	if err != nil {
		return Enrollment{}, err
	}
	manager.startWorker(enrollment)
	return enrollment, nil
}

func (manager *Manager) Forget(ctx context.Context, runner string) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	enrollment, err := manager.store.Get(ctx, runner)
	if err != nil {
		return err
	}
	if enrollment.State != "revoked" {
		return ErrAuthorization
	}
	if worker := manager.workers[runner]; worker != nil {
		select {
		case <-worker.done:
		default:
			return ErrOffline
		}
	}
	for _, kind := range []auth.CredentialKind{auth.RunnerToken, auth.RunnerKey} {
		if err := manager.credentials.Delete(ctx, auth.CredentialRef{Kind: kind, WorkspaceID: enrollment.WorkspaceID, ID: runner}); err != nil && !errors.Is(err, auth.ErrCredentialNotFound) {
			return err
		}
	}
	_, err = manager.store.db.ExecContext(ctx, `DELETE FROM runner_enrollments WHERE id = ? AND connection_state = 'revoked'`, runner)
	if err == nil {
		delete(manager.workers, runner)
	}
	return err
}

func rpcError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrProtocol):
		return &daemon.Failure{Code: "invalid_request"}
	case errors.Is(err, ErrRevoked):
		return &daemon.Failure{Code: "runner_revoked"}
	case errors.Is(err, ErrAuthorization):
		return &daemon.Failure{Code: "runner_authorization_required"}
	case errors.Is(err, ErrOffline):
		return &daemon.Failure{Code: "daemon_offline"}
	case errors.Is(err, auth.ErrCredentialUnavailable), errors.Is(err, auth.ErrCredentialNotFound):
		return &daemon.Failure{Code: "runner_credential_unavailable"}
	default:
		return &daemon.Failure{Code: "storage_failed"}
	}
}

func RegisterRPC(registry *daemon.Registry, manager *Manager) error {
	if err := registry.RegisterService("runner.channels", manager.Start); err != nil {
		return err
	}
	for _, method := range []string{"runner.enroll", "runner.list", "runner.wake", "runner.forget"} {
		if err := registry.Register(method, func(ctx context.Context, request daemon.Request) (map[string]any, error) {
			payload := request.Envelope.Payload
			if method == "runner.list" {
				if len(payload) != 0 {
					return nil, rpcError(ErrProtocol)
				}
				enrollments, err := manager.store.List(ctx)
				return map[string]any{"enrollments": enrollments}, rpcError(err)
			}
			if method == "runner.enroll" {
				origin, _ := payload["app_origin"].(string)
				workspace, _ := payload["workspace_id"].(string)
				label, _ := payload["device_label"].(string)
				if len(payload) != 3 {
					return nil, rpcError(ErrProtocol)
				}
				enrollment, err := manager.Enroll(ctx, origin, workspace, label)
				if err != nil {
					return nil, rpcError(err)
				}
				url, err := EnrollmentURL(enrollment)
				return map[string]any{"enrollment": enrollment, "enrollment_url": url}, rpcError(err)
			}
			runner, _ := payload["runner_id"].(string)
			if len(payload) != 1 || !ulidPattern.MatchString(runner) {
				return nil, rpcError(ErrProtocol)
			}
			if method == "runner.forget" {
				err := manager.Forget(ctx, runner)
				return map[string]any{"runner_id": runner, "forgotten": err == nil}, rpcError(err)
			}
			if err := manager.Wake(runner); err != nil {
				return nil, rpcError(err)
			}
			enrollment, err := manager.store.Get(ctx, runner)
			return map[string]any{"enrollment": enrollment}, rpcError(err)
		}); err != nil {
			return err
		}
	}
	return nil
}

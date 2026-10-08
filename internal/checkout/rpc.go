// ABOUTME: Registers checkout RPC leaf handlers against the daemon-owned local database.
// ABOUTME: Keeps filesystem inputs local and returns only canonical sanitized checkout summaries.

package checkout

import (
	"context"

	"github.com/qdis/bfb/internal/daemon"
)

func requestFields(payload map[string]any, required, optional []string) bool {
	allowed := map[string]bool{}
	for _, key := range append(append([]string{}, required...), optional...) {
		allowed[key] = true
	}
	for _, key := range required {
		if payload[key] == nil {
			return false
		}
	}
	for key := range payload {
		if !allowed[key] {
			return false
		}
	}
	return true
}

func stringField(payload map[string]any, key string) string {
	value, _ := payload[key].(string)
	return value
}

func RegisterRPC(methods *daemon.Registry) error {
	handlers := map[string]func(context.Context, *Registry, map[string]any) (map[string]any, error){
		"checkout.link": func(ctx context.Context, registry *Registry, payload map[string]any) (map[string]any, error) {
			if !requestFields(payload, []string{"workspace_id", "runner_id", "project_id", "label", "repository_identity", "local_path"}, []string{"workspace_subpath", "remote_name", "is_default"}) {
				return nil, failure("invalid_request")
			}
			isDefault, _ := payload["is_default"].(bool)
			record, err := registry.Link(ctx, LinkInput{
				WorkspaceID: stringField(payload, "workspace_id"), RunnerID: stringField(payload, "runner_id"), ProjectID: stringField(payload, "project_id"),
				Label: stringField(payload, "label"), Path: stringField(payload, "local_path"),
				RepositoryIdentity: stringField(payload, "repository_identity"), WorkspaceSubpath: stringField(payload, "workspace_subpath"),
				RemoteName: stringField(payload, "remote_name"), IsDefault: isDefault,
			})
			if err != nil {
				return nil, err
			}
			return map[string]any{"checkout": record.Summary}, nil
		},
		"checkout.list": func(ctx context.Context, registry *Registry, payload map[string]any) (map[string]any, error) {
			if !requestFields(payload, nil, []string{"workspace_id", "runner_id", "project_id", "limit", "after_checkout_id"}) {
				return nil, failure("invalid_request")
			}
			limit, _ := payload["limit"].(float64)
			items, next, err := registry.List(ctx, ListOptions{
				WorkspaceID: stringField(payload, "workspace_id"), RunnerID: stringField(payload, "runner_id"), ProjectID: stringField(payload, "project_id"),
				After: stringField(payload, "after_checkout_id"), Limit: int(limit),
			})
			if err != nil {
				return nil, err
			}
			result := map[string]any{"checkouts": items}
			if next != "" {
				result["next_checkout_id"] = next
			}
			return result, nil
		},
		"checkout.verify": func(ctx context.Context, registry *Registry, payload map[string]any) (map[string]any, error) {
			if !requestFields(payload, []string{"checkout_id"}, nil) {
				return nil, failure("invalid_request")
			}
			record, err := registry.Verify(ctx, stringField(payload, "checkout_id"))
			if err != nil {
				return nil, err
			}
			return map[string]any{"checkout": record.Summary}, nil
		},
		"checkout.unlink": func(ctx context.Context, registry *Registry, payload map[string]any) (map[string]any, error) {
			if !requestFields(payload, []string{"checkout_id"}, nil) {
				return nil, failure("invalid_request")
			}
			id := stringField(payload, "checkout_id")
			if err := registry.Unlink(ctx, id); err != nil {
				return nil, err
			}
			return map[string]any{"checkout_id": id, "unlinked": true}, nil
		},
	}
	for method, handler := range handlers {
		if err := methods.Register(method, func(ctx context.Context, request daemon.Request) (map[string]any, error) {
			if request.Store == nil {
				return nil, failure("internal_error")
			}
			return handler(ctx, NewRegistry(request.Store.DB), request.Envelope.Payload)
		}); err != nil {
			return err
		}
	}
	return nil
}

// ABOUTME: Implements the bounded provider hook entry point with offline inbox fallback.
// ABOUTME: Returns hook latency from local commits only; cloud upload stays asynchronous.

package cli

import (
	"context"
	"database/sql"
	"io"
	"os"
	"strconv"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/journal"
	"github.com/qdis/bfb/internal/provider"
)

// BackendFactory resolves journal assignment and observer views over the hook
// database. The CLI never imports supervision packages directly.
type BackendFactory func(db *sql.DB) (journal.Assignments, journal.Observers)

// RegisterHook exposes hook ingest and status without duplicating journal logic.
func RegisterHook(registry *Registry, providers *provider.Registry, backend BackendFactory) {
	if providers == nil || backend == nil {
		panic("hook commands require a provider registry and journal backend")
	}
	if err := registry.Register(Command{Path: "hook ingest", Method: "hook.ingest", Summary: "Ingest one bounded provider hook event", Run: func(ctx context.Context, invocation Invocation) (map[string]any, error) {
		return ingestHook(ctx, invocation, providers, backend)
	}}); err != nil {
		panic("duplicate built-in CLI command")
	}
	if err := registry.Register(Command{Path: "hook status", Method: "hook.status", Summary: "Show journal backlog and telemetry state", Run: func(ctx context.Context, invocation Invocation) (map[string]any, error) {
		return hookStatus(ctx, invocation)
	}}); err != nil {
		panic("duplicate built-in CLI command")
	}
}

func ingestHook(ctx context.Context, invocation Invocation, providers *provider.Registry, backend BackendFactory) (map[string]any, error) {
	if len(invocation.Args) != 2 || invocation.Args[0] != "--provider" || invocation.Args[1] == "" {
		return nil, &daemon.Failure{Code: "invalid_request"}
	}
	name := invocation.Args[1]
	raw, err := io.ReadAll(io.LimitReader(invocation.Input, provider.MaxHookBytes+1))
	if err != nil || len(raw) == 0 || len(raw) > provider.MaxHookBytes {
		return nil, &daemon.Failure{Code: "provider_event_invalid"}
	}
	execution := os.Getenv("BFB_RUN_EXECUTION_ID")
	generation, genErr := strconv.ParseInt(os.Getenv("BFB_ASSIGNMENT_GENERATION"), 10, 64)
	token := os.Getenv("BFB_CORRELATION_TOKEN")
	if execution == "" || genErr != nil || generation < 1 || token == "" {
		return nil, &daemon.Failure{Code: "invalid_request"}
	}
	input := journal.HookInput{
		Provider: name, Raw: raw, ExecutionID: execution, Generation: generation, Token: token,
		WorkspaceID: os.Getenv("BFB_WORKSPACE_ID"), ProjectID: os.Getenv("BFB_PROJECT_ID"),
		TaskID: os.Getenv("BFB_TASK_ID"), RunID: os.Getenv("BFB_RUN_ID"),
		CapturedAt: time.Now(),
	}
	bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	state, err := daemon.OpenStore(bounded, invocation.Paths)
	if err != nil {
		return inboxFallback(invocation.Paths.Root, input, err)
	}
	defer state.Close()
	store := journal.NewStore(state.DB)
	assignments, _ := backend(state.DB)
	receipt, err := store.Ingest(bounded, assignments, providers, input, time.Now())
	if err != nil {
		name, fallbackErr := inboxFallback(invocation.Paths.Root, input, err)
		if fallbackErr != nil {
			return nil, fallbackErr
		}
		return name, nil
	}
	return receiptPayload(receipt), nil
}

func inboxFallback(root string, input journal.HookInput, cause error) (map[string]any, error) {
	if !isFallbackEligible(cause) {
		return nil, cause
	}
	if _, err := journal.WriteCapture(root, input.Token, input.ExecutionID, input.Generation, input.Provider, input.Raw, input.CapturedAt); err != nil {
		return nil, err
	}
	return map[string]any{"hook_status": "inbox"}, nil
}

func isFallbackEligible(err error) bool {
	switch daemon.AsFailure(err).Diagnostic().Code {
	case "daemon_offline", "storage_failed", "execution_capacity", "telemetry_degraded", "inbox_full":
		return true
	default:
		return false
	}
}

func receiptPayload(receipt journal.Receipt) map[string]any {
	payload := map[string]any{"hook_status": receipt.Status}
	if receipt.EventID != "" {
		payload["hook_event_id"] = receipt.EventID
	}
	if receipt.Sequence != 0 {
		payload["hook_sequence"] = receipt.Sequence
	}
	if receipt.Code != "" {
		payload["hook_code"] = receipt.Code
	}
	return payload
}

func hookStatus(ctx context.Context, invocation Invocation) (map[string]any, error) {
	if len(invocation.Args) != 0 {
		return nil, &daemon.Failure{Code: "invalid_request"}
	}
	bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	db, err := daemon.OpenReader(bounded, invocation.Paths)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	store := journal.NewStore(db)
	counts, err := store.Counts(bounded)
	if err != nil {
		return nil, err
	}
	degraded, reason, err := store.Degraded(bounded)
	if err != nil {
		return nil, err
	}
	payload := map[string]any{
		"hook_pending": counts.Pending, "hook_quarantined": counts.Quarantined,
		"telemetry_degraded": degraded,
	}
	if reason != "" {
		payload["degraded_reason"] = reason
	}
	return payload, nil
}

// ABOUTME: Delivers freshly authorized signal intents only to the original signed execution helper.
// ABOUTME: Rechecks native ownership after online authorization and durably marks delivery before replying.

package supervisor

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
)

type controlResultRequest struct {
	IntentID    string `json:"terminal_intent_id"`
	ControlID   string `json:"control_id"`
	Disposition string `json:"control_disposition"`
}

// runtimeOwner authenticates before reading the private assignment. It does
// not reuse the old launch deadline or require the provider to remain a BFB
// exec wrapper. Results may arrive after the owned group has already ended.
func (service *Service) runtimeOwner(ctx context.Context, peer daemon.Peer, intent string) (LocalAssignment, error) {
	owner, err := service.options.InspectHelper(peer)
	if err != nil {
		return LocalAssignment{}, failure("peer_denied")
	}
	if service.store == nil || service.files == nil {
		return LocalAssignment{}, failure("daemon_offline")
	}
	assignment, err := service.store.ByIntent(ctx, intent)
	if err != nil {
		return LocalAssignment{}, err
	}
	if assignment.Supervisor == nil || *assignment.Supervisor != owner {
		return LocalAssignment{}, failure("peer_denied")
	}
	return assignment, nil
}

func (service *Service) controlOwner(ctx context.Context, peer daemon.Peer, intent string) (LocalAssignment, error) {
	assignment, err := service.runtimeOwner(ctx, peer, intent)
	if err != nil {
		return LocalAssignment{}, err
	}
	if assignment.Group == nil || assignment.LockID == "" || (assignment.State != "group_ready" && assignment.State != "running") {
		return LocalAssignment{}, failure("execution_assignment_invalid")
	}
	facts, _, err := service.inspectNative(ctx, service.store, service.nativeInspector(service.paths, service.files), assignment)
	if err != nil || facts.SupervisorState != "verified" || facts.GroupState != "live" || facts.LockState != "held" || facts.Descendants != "contained" ||
		facts.History.Uncertain || facts.History.LocalReleasedAt != "" || facts.History.Group == nil || facts.History.Group.Unknown || facts.History.Group.HadEscape || facts.History.Group.Incomplete {
		return LocalAssignment{}, failure("containment_unknown")
	}
	return assignment, nil
}

func (store *IntentStore) preparedSignal(ctx context.Context, assignment LocalAssignment) (*controlEffect, error) {
	effect, err := scanControl(store.db.QueryRowContext(ctx, "SELECT "+controlColumns+` FROM execution_control_effects
WHERE execution_id = ? AND assignment_generation = ? AND runner_id = ? AND state = 'prepared'
AND action IN ('interrupt','terminate','cancel') AND EXISTS (
SELECT 1 FROM execution_commands c WHERE c.command_id = execution_control_effects.control_id
AND c.runner_id = execution_control_effects.runner_id AND c.command_kind = 'run_control' AND c.state IN ('queued','waiting'))
ORDER BY control_id LIMIT 1`, assignment.Claim.Assignment.RunExecutionId, assignment.Claim.Assignment.AssignmentGeneration, assignment.Claim.Assignment.RunnerId))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, failure("storage_failed")
	}
	return &effect, nil
}

func (service *Service) pollControl(ctx context.Context, request daemon.Request) (map[string]any, error) {
	intent, ok := request.Envelope.Payload["terminal_intent_id"].(string)
	if !ok || len(request.Envelope.Payload) != 1 || !terminalIntent.MatchString(intent) {
		return nil, failure("invalid_request")
	}
	if err := service.waitReady(ctx); err != nil {
		return nil, err
	}
	service.mu.RLock()
	defer service.mu.RUnlock()
	assignment, err := service.controlOwner(ctx, request.Peer, intent)
	if err != nil {
		return nil, err
	}
	effect, err := service.store.preparedSignal(ctx, assignment)
	if err != nil || effect == nil {
		return map[string]any{}, err
	}
	command, err := service.store.Command(ctx, effect.RunnerID, effect.ID)
	if err != nil {
		return nil, err
	}
	if service.options.Connection == nil {
		return nil, failure("daemon_offline")
	}
	connection, err := service.options.Connection(effect.RunnerID)
	if err != nil || connection == nil {
		return nil, failure("daemon_offline")
	}
	body, err := effect.claimRequest()
	if err != nil {
		return nil, err
	}
	started := service.options.Now()
	ctx, cancel := context.WithTimeout(ctx, finalRequestLimit)
	defer cancel()
	data, err := requestLaunch(ctx, connection, "controls/claim", body)
	if err != nil || ctx.Err() != nil {
		return nil, failure("execution_authorization_failed")
	}
	receipt, err := controlOutcome(data, command)
	if err != nil || !effect.matches(command, receipt) {
		return nil, failure("execution_assignment_invalid")
	}
	if controlTerminal(receipt) {
		return map[string]any{}, service.store.completeControl(ctx, command, receipt)
	}
	if receipt.State != "claimed" {
		return nil, failure("execution_authorization_failed")
	}
	current, err := service.store.rememberControl(ctx, command, receipt)
	if err != nil {
		return nil, err
	}
	observed, err := service.controlOwner(ctx, request.Peer, intent)
	if err != nil || !sameObservedAssignment(assignment, observed) {
		return nil, failure("containment_unknown")
	}
	now := service.options.Now()
	if ctx.Err() != nil || now.Before(started) || now.Sub(started) > finalRequestLimit {
		return nil, failure("execution_authorization_failed")
	}
	delivery, err := service.store.beginControl(ctx, command, current, observed, now)
	if err != nil {
		return nil, err
	}
	// A lost reply cannot make this delivery prepared again. The helper must
	// independently check this timestamp and expiry immediately before acting.
	return map[string]any{"execution_control": generated.LocalExecutionControl{
		SchemaVersion: 1, TerminalIntentId: intent, ControlId: delivery.ID,
		RunExecutionId: delivery.ExecutionID, AssignmentGeneration: delivery.Generation,
		Action: delivery.Action, AuthorizedAt: delivery.StartedAt, ExpiresAt: delivery.ExpiresAt,
	}}, nil
}

func (service *Service) recordControl(ctx context.Context, request daemon.Request) (map[string]any, error) {
	var input controlResultRequest
	data, err := json.Marshal(request.Envelope.Payload)
	if err != nil || len(request.Envelope.Payload) != 3 || strictPrivateJSON(data, &input) != nil ||
		!terminalIntent.MatchString(input.IntentID) || !executionID.MatchString(input.ControlID) ||
		(input.Disposition != "applied" && input.Disposition != "local_rejected" && input.Disposition != "delivery_unknown") {
		return nil, failure("invalid_request")
	}
	if err := service.waitReady(ctx); err != nil {
		return nil, err
	}
	service.mu.RLock()
	defer service.mu.RUnlock()
	assignment, err := service.runtimeOwner(ctx, request.Peer, input.IntentID)
	if err != nil {
		return nil, err
	}
	command, err := service.store.Command(ctx, assignment.Claim.Assignment.RunnerId, input.ControlID)
	if err != nil {
		return nil, err
	}
	effect, err := service.store.control(ctx, command)
	if err != nil || effect == nil || effect.ExecutionID != assignment.Claim.Assignment.RunExecutionId || effect.Generation != assignment.Claim.Assignment.AssignmentGeneration ||
		(effect.Action != "interrupt" && effect.Action != "terminate" && effect.Action != "cancel") {
		return nil, failure("execution_assignment_invalid")
	}
	if err := service.store.finishControl(ctx, *effect, input.Disposition); err != nil {
		return nil, err
	}
	select {
	case service.controlWake <- struct{}{}:
	default:
	}
	return map[string]any{}, nil
}

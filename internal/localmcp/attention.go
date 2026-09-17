// ABOUTME: Implements the three A02 attention tools over the activated run capability.
// ABOUTME: Waits poll committed state with a 30-second bound and never memoize pending outcomes.

package localmcp

import (
	"context"
	"time"
)

// attentionWaitTimeout bounds one bfb_wait_for_attention call. The waiter
// polls committed attention state and returns pending on expiry; a repeated
// wait is side-effect free. Tests inject shorter deadlines via context.
const attentionWaitTimeout = 30 * time.Second

// attentionPollInterval spaces committed-state polls inside one bounded wait.
const attentionPollInterval = 100 * time.Millisecond

// attentionKinds is the frozen A02 kind set from docs/contracts/attention.md.
var attentionKinds = map[string]bool{
	"clarification": true, "review": true, "credential": true,
	"capability": true, "destructive_action": true, "blocker": true,
}

// AttentionRequest carries a typed human-decision request. ReferenceKind and
// ReferenceID travel as a pair naming one immutable object, or stay empty.
type AttentionRequest struct {
	Kind          string
	Question      string
	ReferenceKind string
	ReferenceID   string
	Blocking      bool
}

// AttentionRecord is the committed resolution metadata for one request. The
// waiter and later retrieval return this same shape; only state, answer, and
// timestamps advance.
type AttentionRecord struct {
	ID              string `json:"id"`
	Kind            string `json:"kind"`
	State           string `json:"state"`
	Question        string `json:"question"`
	Answer          string `json:"answer"`
	RequiredRole    string `json:"required_role"`
	Blocking        bool   `json:"blocking"`
	ResourceVersion int64  `json:"resource_version"`
	RequestedAt     string `json:"requested_at"`
	AnsweredAt      string `json:"answered_at"`
	ResolvedAt      string `json:"resolved_at"`
	FirstResponseAt string `json:"first_response_at"`
}

// validateAttention checks kind, question, reference pairing, and blocking
// flag before any capability or transport effect.
func validateAttention(params map[string]any) (AttentionRequest, error) {
	rawKind, _ := params["kind"].(string)
	if !attentionKinds[rawKind] {
		return AttentionRequest{}, fail("invalid_params")
	}
	rawQuestion, _ := params["question"].(string)
	question, err := boundedText(rawQuestion, "question", maxBodyLen)
	if err != nil {
		return AttentionRequest{}, err
	}
	request := AttentionRequest{Kind: rawKind, Question: question}
	if raw, present := params["reference_kind"]; present {
		kind, ok := raw.(string)
		if !ok || kind == "" || len(kind) > 64 {
			return AttentionRequest{}, fail("invalid_params")
		}
		request.ReferenceKind = kind
	}
	if raw, present := params["reference_id"]; present {
		id, ok := raw.(string)
		if !ok || checkID(id, "reference_id") != nil {
			return AttentionRequest{}, fail("invalid_params")
		}
		request.ReferenceID = id
	}
	if (request.ReferenceKind == "") != (request.ReferenceID == "") {
		return AttentionRequest{}, fail("invalid_params")
	}
	blocking, ok := params["blocking"].(bool)
	if !ok {
		return AttentionRequest{}, fail("invalid_params")
	}
	request.Blocking = blocking
	return request, nil
}

// requestAttention validates, authorizes, and executes bfb_request_human.
// Online it commits through the transport; offline it journals a durable
// pending_sync exactly like the other run mutations.
func (host *Host) requestAttention(ctx context.Context, params map[string]any, requestID string) (any, error) {
	if result, ok := host.cached(requestID); ok {
		return result, nil
	}
	request, err := validateAttention(params)
	if err != nil {
		return nil, err
	}
	if err := host.capability.allowWrite(ctx); err != nil {
		return nil, err
	}
	if !host.transport.Online() {
		return nil, fail("offline_rejected")
	}
	boundary := host.capability.Boundary()
	result, err := host.transport.RequestAttention(ctx, boundary, request, requestID)
	if err != nil {
		return nil, err
	}
	host.remember(requestID, result)
	return result, nil
}

// getAttention returns the committed metadata for one of the run's own
// requests. Reads never journal; an unreachable channel fails visibly.
func (host *Host) getAttention(ctx context.Context, params map[string]any, requestID string) (any, error) {
	if err := host.capability.allowRead(ctx); err != nil {
		return nil, err
	}
	rawID, _ := params["attention_id"].(string)
	if checkID(rawID, "attention_id") != nil {
		return nil, fail("invalid_params")
	}
	if !host.transport.Online() {
		return nil, fail("offline_rejected")
	}
	result, err := host.transport.GetAttention(ctx, host.capability.Boundary(), rawID)
	if err != nil {
		return nil, err
	}
	host.remember(requestID, result)
	return result, nil
}

// waitForAttention polls committed state until the request is answered or
// the 30-second bound expires. Pending outcomes are never memoized: a
// repeated wait re-reads committed state and is safe to repeat. A context
// deadline earlier than the bound shortens the wait.
func (host *Host) waitForAttention(ctx context.Context, params map[string]any) (any, error) {
	if err := host.capability.allowRead(ctx); err != nil {
		return nil, err
	}
	rawID, _ := params["attention_id"].(string)
	if checkID(rawID, "attention_id") != nil {
		return nil, fail("invalid_params")
	}
	deadline := time.Now().Add(attentionWaitTimeout)
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
		deadline = ctxDeadline
	}
	boundary := host.capability.Boundary()
	for {
		if !host.transport.Online() {
			return nil, fail("offline_rejected")
		}
		record, err := host.transport.GetAttention(ctx, boundary, rawID)
		if err != nil {
			return nil, err
		}
		if record.State == "answered" || record.State == "resolved" {
			return map[string]any{"status": record.State, "attention": record}, nil
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return map[string]any{"status": "pending"}, nil
		}
		pause := attentionPollInterval
		if remaining < pause {
			pause = remaining
		}
		select {
		case <-ctx.Done():
			return map[string]any{"status": "pending"}, nil
		case <-time.After(pause):
		}
	}
}

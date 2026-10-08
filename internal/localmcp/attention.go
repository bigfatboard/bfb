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
const attentionPollInterval = time.Second

func attentionTool(name string) bool {
	return name == "bfb_request_human" || name == "bfb_get_attention" || name == "bfb_wait_for_attention"
}

func attentionWaitExpired(ctx context.Context) bool {
	if ctx.Err() != nil {
		return true
	}
	deadline, bounded := ctx.Deadline()
	return bounded && !time.Now().Before(deadline)
}

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
		if !ok {
			return AttentionRequest{}, fail("invalid_params")
		}
		normalized, err := boundedText(kind, "reference_kind", 64)
		if err != nil {
			return AttentionRequest{}, err
		}
		request.ReferenceKind = normalized
	}
	if raw, present := params["reference_id"]; present {
		id, ok := raw.(string)
		if !ok {
			return AttentionRequest{}, fail("invalid_params")
		}
		normalized, err := boundedText(id, "reference_id", 128)
		if err != nil {
			return AttentionRequest{}, err
		}
		request.ReferenceID = normalized
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
// Every explicit retry reaches current authority and the cloud's original
// operation identity. Offline it fails visibly without opening any journal.
func (host *Host) requestAttention(ctx context.Context, params map[string]any, requestID string) (any, error) {
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
	result, err := host.transport.RequestAttention(ctx, boundary, host.capability.ConfirmedSession(), request, requestID)
	if err != nil {
		return nil, err
	}
	host.remember(requestID, nil)
	return result, nil
}

// getAttention returns the committed metadata for one of the run's own
// requests. Reads never journal; an unreachable channel fails visibly.
func (host *Host) getAttention(ctx context.Context, params map[string]any, requestID string) (any, error) {
	rawID, _ := params["attention_id"].(string)
	if checkID(rawID, "attention_id") != nil {
		return nil, fail("invalid_params")
	}
	result, err := host.readAttention(ctx, rawID, requestID)
	if err != nil {
		return nil, err
	}
	host.remember(requestID, nil)
	return result, nil
}

func (host *Host) readAttention(ctx context.Context, attentionID, requestID string) (AttentionRecord, error) {
	if _, fixed := host.transport.(daemonAttentionTransport); fixed {
		if host.capability.State() == StateClosed {
			return AttentionRecord{}, fail("capability_closed")
		}
	} else if err := host.capability.allowRead(ctx); err != nil {
		return AttentionRecord{}, err
	}
	if !host.transport.Online() {
		return AttentionRecord{}, fail("offline_rejected")
	}
	var session *ConfirmedSession
	if host.capability.State() == StateActivated {
		confirmed := host.capability.ConfirmedSession()
		session = &confirmed
	}
	result, err := host.transport.GetAttention(ctx, host.capability.Boundary(), session, attentionID, requestID)
	if err != nil {
		return AttentionRecord{}, err
	}
	if host.capability.State() == StateClosed {
		return AttentionRecord{}, fail("capability_closed")
	}
	return result, nil
}

// waitForAttention polls committed state until the request is answered or
// the 30-second bound expires. Pending outcomes are never memoized: a
// repeated wait re-reads committed state and is safe to repeat. A context
// deadline earlier than the bound shortens the wait.
func (host *Host) waitForAttention(ctx context.Context, params map[string]any, requestID string) (any, error) {
	rawID, _ := params["attention_id"].(string)
	if checkID(rawID, "attention_id") != nil {
		return nil, fail("invalid_params")
	}
	ctx, cancel := context.WithTimeout(ctx, attentionWaitTimeout)
	defer cancel()
	for {
		if attentionWaitExpired(ctx) {
			return map[string]any{"status": "pending"}, nil
		}
		record, err := host.readAttention(ctx, rawID, requestID)
		if err != nil {
			if attentionWaitExpired(ctx) && (CodeOf(err) == "offline_rejected" || CodeOf(err) == "work_unavailable") {
				return map[string]any{"status": "pending"}, nil
			}
			return nil, err
		}
		// Never release a private late answer, even if a transport ignored cancellation.
		if attentionWaitExpired(ctx) {
			return map[string]any{"status": "pending"}, nil
		}
		if record.State == "answered" || record.State == "resolved" {
			return map[string]any{"status": record.State, "attention": record}, nil
		}
		select {
		case <-ctx.Done():
			return map[string]any{"status": "pending"}, nil
		case <-time.After(attentionPollInterval):
		}
	}
}

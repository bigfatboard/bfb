// ABOUTME: Dispatches the six v1 tools over an activated capability with strict argument bounds.
// ABOUTME: Derives every identifier from the capability; caller-supplied IDs can only narrow, never widen.

package localmcp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// ToolDescriptor advertises one tool for tools/list.
type ToolDescriptor struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

func stringSchema(description string, min, max int) map[string]any {
	return map[string]any{"type": "string", "description": description, "minLength": min, "maxLength": max}
}

// ToolDescriptors is the frozen v1 tool surface from docs/contracts/local-mcp.md.
func ToolDescriptors() []ToolDescriptor {
	requestID := stringSchema("Idempotency key, 8-128 characters.", minRequestIDLen, maxRequestIDLen)
	optionalTask := map[string]any{"type": "string", "description": "Optional task ID; must equal the run boundary.", "maxLength": maxIDLen}
	return []ToolDescriptor{
		{Name: "bfb_get_context", Description: "Read the run's scoped agent context with a delivery record.", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"task_id": optionalTask, "request_id": requestID}, "required": []string{"request_id"}, "additionalProperties": false}},
		{Name: "bfb_get_task", Description: "Read the run's agent-visible task view.", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"task_id": optionalTask, "request_id": requestID}, "required": []string{"request_id"}, "additionalProperties": false}},
		{Name: "bfb_update_task", Description: "Update permitted task fields with an optimistic version check.", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"task_id": optionalTask, "expected_version": map[string]any{"type": "integer", "minimum": 1}, "title": stringSchema("Replacement title.", 1, maxTitleLen), "punchline": stringSchema("Replacement punchline.", 1, maxTitleLen), "request_id": requestID}, "required": []string{"expected_version", "request_id"}, "additionalProperties": false}},
		{Name: "bfb_add_comment", Description: "Add a discussion comment attributed to the agent run.", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"task_id": optionalTask, "body": stringSchema("Comment body.", 1, maxBodyLen), "request_id": requestID}, "required": []string{"body", "request_id"}, "additionalProperties": false}},
		{Name: "bfb_report_progress", Description: "Publish a bounded progress checkpoint.", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"task_id": optionalTask, "summary": stringSchema("Progress summary.", 1, maxBodyLen), "percent": map[string]any{"type": "number", "minimum": 0, "maximum": 100}, "confidence": map[string]any{"type": "number", "minimum": 0, "maximum": 1}, "request_id": requestID}, "required": []string{"summary", "request_id"}, "additionalProperties": false}},
		{Name: "bfb_propose_task", Description: "Propose a root task or a policy-bounded child task.", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"project_id": map[string]any{"type": "string", "description": "Optional project ID; must equal the run boundary.", "maxLength": maxIDLen}, "parent_task_id": map[string]any{"type": "string", "description": "Optional parent task ID; must equal the run boundary task.", "maxLength": maxIDLen}, "title": stringSchema("Proposed title.", 1, maxTitleLen), "priority": map[string]any{"type": "string", "enum": []string{"P0", "P1", "P2", "P3"}}, "request_id": requestID}, "required": []string{"title", "request_id"}, "additionalProperties": false}},
		{Name: "bfb_request_human", Description: "Request a typed human decision from the run's attention queue.", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"kind": map[string]any{"type": "string", "description": "Attention kind.", "enum": []string{"clarification", "review", "credential", "capability", "destructive_action", "blocker"}}, "question": stringSchema("Bounded question for the human.", 1, maxBodyLen), "reference_kind": map[string]any{"type": "string", "description": "Optional immutable-object kind; travels with reference_id.", "maxLength": 64}, "reference_id": map[string]any{"type": "string", "description": "Optional immutable-object ID; travels with reference_kind.", "maxLength": maxIDLen}, "blocking": map[string]any{"type": "boolean", "description": "Whether the run is blocked on the answer."}, "request_id": requestID}, "required": []string{"kind", "question", "blocking", "request_id"}, "additionalProperties": false}},
		{Name: "bfb_get_attention", Description: "Read the committed metadata for one of the run's attention requests.", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"attention_id": map[string]any{"type": "string", "description": "Attention request ID; must belong to the run.", "maxLength": maxIDLen}, "request_id": requestID}, "required": []string{"attention_id", "request_id"}, "additionalProperties": false}},
		{Name: "bfb_wait_for_attention", Description: "Poll committed attention state for up to 30 seconds, then report pending.", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"attention_id": map[string]any{"type": "string", "description": "Attention request ID; must belong to the run.", "maxLength": maxIDLen}, "request_id": requestID}, "required": []string{"attention_id", "request_id"}, "additionalProperties": false}},
		{Name: "bfb_submit_result", Description: "Submit an immutable result summary with evidence for human review.", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"summary": stringSchema("Result summary.", 1, maxSummaryLen), "limitations": stringSchema("Known limitations.", 1, maxLimitationsLen), "evidence_refs": map[string]any{"type": "array", "description": "At most 20 generic evidence references.", "maxItems": maxEvidenceRefs, "items": map[string]any{"type": "object"}}, "git_branch": stringSchema("Observed Git branch.", 1, maxBranchLen), "git_commit": stringSchema("Observed 40-character Git commit.", 40, 40), "git_dirty": map[string]any{"type": "boolean", "description": "Whether the observed worktree was dirty."}, "request_id": requestID}, "required": []string{"summary", "request_id"}, "additionalProperties": false}},
	}
}

// Host executes tools for one stdio connection. It owns the connection's
// idempotency map; the capability owns trust state; the journal owns offline
// durability. Host is safe for concurrent tools/call handling.
type Host struct {
	mutex      sync.Mutex
	capability *Capability
	transport  WorkTransport
	journal    Journal
	policy     OfflinePolicy
	principal  string
	grant      string
	now        func() time.Time
	seen       map[string]any
}

// HostDeps wires one connection's host. Principal names the originating
// agent-run principal (agent_run:<run_id>) and grant its runner grant.
type HostDeps struct {
	Capability *Capability
	Transport  WorkTransport
	Journal    Journal
	Policy     OfflinePolicy
	Principal  string
	Grant      string
	Now        func() time.Time
}

// NewHost builds the connection host. Nil Journal means offline writes fail
// visibly instead of journaling; nil Policy defaults to pending allowed.
func NewHost(deps HostDeps) *Host {
	policy := deps.Policy
	if policy == nil {
		policy = DefaultOfflinePolicy{AllowPending: true}
	}
	now := deps.Now
	if now == nil {
		now = time.Now
	}
	return &Host{
		capability: deps.Capability,
		transport:  deps.Transport,
		journal:    deps.Journal,
		policy:     policy,
		principal:  deps.Principal,
		grant:      deps.Grant,
		now:        now,
		seen:       make(map[string]any),
	}
}

func (host *Host) cached(requestID string) (any, bool) {
	host.mutex.Lock()
	defer host.mutex.Unlock()
	result, ok := host.seen[requestID]
	return result, ok
}

func (host *Host) remember(requestID string, result any) {
	host.mutex.Lock()
	defer host.mutex.Unlock()
	if len(host.seen) >= 256 {
		return
	}
	host.seen[requestID] = result
}

// CallTool validates, authorizes, executes, and memoizes one tools/call.
// Params arrive decoded from JSON-RPC; unknown fields are rejected so a
// caller cannot smuggle workflow, routing, or identity fields.
func (host *Host) CallTool(ctx context.Context, name string, params map[string]any) (any, error) {
	known := false
	for _, descriptor := range ToolDescriptors() {
		if descriptor.Name == name {
			known = true
		}
	}
	if !known {
		if name == "bfb_publish_artifact" ||
			name == "bfb_list_projects" || name == "bfb_list_tasks" {
			return nil, fail("not_implemented")
		}
		return nil, fail("method_not_found")
	}
	if params == nil {
		return nil, fail("invalid_params")
	}
	allowed := allowedParams(name)
	for key := range params {
		if !allowed[key] {
			return nil, fail("invalid_params")
		}
	}
	rawRequestID, _ := params["request_id"].(string)
	if err := checkRequestID(rawRequestID); err != nil {
		return nil, err
	}
	if result, ok := host.cached(rawRequestID); ok {
		return result, nil
	}
	boundary := host.capability.Boundary()
	if value, present := params["task_id"]; present {
		id, ok := value.(string)
		if !ok || checkID(id, "task_id") != nil || boundary.checkTask(id) != nil {
			return nil, fail("boundary_escape")
		}
	}
	switch name {
	case "bfb_get_context", "bfb_get_task":
		result, err := host.read(ctx, name)
		if err != nil {
			return nil, err
		}
		host.remember(rawRequestID, result)
		return result, nil
	case "bfb_request_human":
		return host.requestAttention(ctx, params, rawRequestID)
	case "bfb_get_attention":
		return host.getAttention(ctx, params, rawRequestID)
	case "bfb_wait_for_attention":
		return host.waitForAttention(ctx, params)
	default:
		result, err := host.write(ctx, name, params, rawRequestID, boundary)
		if err != nil {
			return nil, err
		}
		host.remember(rawRequestID, result)
		return result, nil
	}
}

func allowedParams(name string) map[string]bool {
	common := map[string]bool{"task_id": true, "request_id": true}
	switch name {
	case "bfb_update_task":
		return map[string]bool{"task_id": true, "request_id": true, "expected_version": true, "title": true, "punchline": true}
	case "bfb_add_comment":
		return map[string]bool{"task_id": true, "request_id": true, "body": true}
	case "bfb_report_progress":
		return map[string]bool{"task_id": true, "request_id": true, "summary": true, "percent": true, "confidence": true}
	case "bfb_propose_task":
		return map[string]bool{"request_id": true, "project_id": true, "parent_task_id": true, "title": true, "priority": true}
	case "bfb_request_human":
		return map[string]bool{"request_id": true, "kind": true, "question": true, "reference_kind": true, "reference_id": true, "blocking": true}
	case "bfb_get_attention", "bfb_wait_for_attention":
		return map[string]bool{"request_id": true, "attention_id": true}
	case "bfb_submit_result":
		return map[string]bool{"request_id": true, "summary": true, "limitations": true, "evidence_refs": true, "git_branch": true, "git_commit": true, "git_dirty": true}
	default:
		return common
	}
}

func (host *Host) read(ctx context.Context, name string) (any, error) {
	if err := host.capability.allowRead(ctx); err != nil {
		return nil, err
	}
	if !host.transport.Online() {
		return nil, fail("offline_rejected")
	}
	boundary := host.capability.Boundary()
	switch name {
	case "bfb_get_context":
		items, delivery, err := host.transport.GetContext(ctx, boundary)
		if err != nil {
			return nil, err
		}
		return map[string]any{"context": items, "delivery": delivery}, nil
	default:
		task, err := host.transport.GetTask(ctx, boundary)
		if err != nil {
			return nil, err
		}
		return map[string]any{"task": task}, nil
	}
}

func (host *Host) write(ctx context.Context, name string, params map[string]any, requestID string, boundary Boundary) (any, error) {
	if err := host.capability.allowWrite(ctx); err != nil {
		return nil, err
	}
	payload, err := validatedPayload(name, params, boundary)
	if err != nil {
		return nil, err
	}
	if !host.transport.Online() {
		return host.offline(name, payload, requestID, boundary)
	}
	switch name {
	case "bfb_update_task":
		return host.transport.UpdateTask(ctx, boundary, payload.update, requestID)
	case "bfb_add_comment":
		return host.transport.AddComment(ctx, boundary, payload.comment, requestID)
	case "bfb_report_progress":
		return host.transport.ReportProgress(ctx, boundary, payload.summary, payload.percent, payload.confidence, requestID)
	case "bfb_submit_result":
		return host.transport.SubmitResult(ctx, boundary, payload.submit, requestID)
	default:
		return host.transport.ProposeTask(ctx, boundary, payload.propose, requestID)
	}
}

type validatedWrite struct {
	update     UpdateTaskInput
	comment    string
	summary    string
	percent    *float64
	confidence *float64
	propose    ProposeTaskInput
	submit     SubmitResultInput
	canonical  map[string]any
	version    int64
}

func validatedPayload(name string, params map[string]any, boundary Boundary) (*validatedWrite, error) {
	payload := &validatedWrite{canonical: map[string]any{"tool": name}}
	switch name {
	case "bfb_update_task":
		version, ok := params["expected_version"].(float64)
		if !ok {
			return nil, fail("invalid_params")
		}
		number, err := checkVersion(version)
		if err != nil {
			return nil, err
		}
		input := UpdateTaskInput{ExpectedVersion: number}
		canonical := map[string]any{"expected_version": number}
		if raw, present := params["title"]; present {
			text, ok := raw.(string)
			if !ok {
				return nil, fail("invalid_params")
			}
			title, err := boundedText(text, "title", maxTitleLen)
			if err != nil {
				return nil, err
			}
			input.Title = &title
			canonical["title"] = title
		}
		if raw, present := params["punchline"]; present {
			text, ok := raw.(string)
			if !ok {
				return nil, fail("invalid_params")
			}
			punchline, err := boundedText(text, "punchline", maxTitleLen)
			if err != nil {
				return nil, err
			}
			input.Punchline = &punchline
			canonical["punchline"] = punchline
		}
		payload.update = input
		payload.canonical = map[string]any{"tool": name, "input": canonical}
		payload.version = number
	case "bfb_add_comment":
		text, ok := params["body"].(string)
		if !ok {
			return nil, fail("invalid_params")
		}
		body, err := boundedText(text, "body", maxBodyLen)
		if err != nil {
			return nil, err
		}
		payload.comment = body
		payload.canonical = map[string]any{"tool": name, "input": map[string]any{"body": body}}
	case "bfb_report_progress":
		text, ok := params["summary"].(string)
		if !ok {
			return nil, fail("invalid_params")
		}
		summary, err := boundedText(text, "summary", maxBodyLen)
		if err != nil {
			return nil, err
		}
		payload.summary = summary
		input := map[string]any{"summary": summary}
		if raw, present := params["percent"]; present {
			number, ok := raw.(float64)
			if !ok || number < 0 || number > 100 {
				return nil, fail("invalid_params")
			}
			value := number
			payload.percent = &value
			input["percent"] = number
		}
		if raw, present := params["confidence"]; present {
			number, ok := raw.(float64)
			if !ok || number < 0 || number > 1 {
				return nil, fail("invalid_params")
			}
			value := number
			payload.confidence = &value
			input["confidence"] = number
		}
		payload.canonical = map[string]any{"tool": name, "input": input}
	case "bfb_propose_task":
		if raw, present := params["project_id"]; present {
			id, ok := raw.(string)
			if !ok || checkID(id, "project_id") != nil || boundary.checkProject(id) != nil {
				return nil, fail("boundary_escape")
			}
		}
		input := ProposeTaskInput{Priority: "P2"}
		canonical := map[string]any{}
		if raw, present := params["parent_task_id"]; present {
			id, ok := raw.(string)
			if !ok || checkID(id, "parent_task_id") != nil || boundary.checkParent(id) != nil {
				return nil, fail("boundary_escape")
			}
			value := boundary.TaskID
			input.ParentTaskID = &value
			canonical["parent_task_id"] = value
		}
		text, ok := params["title"].(string)
		if !ok {
			return nil, fail("invalid_params")
		}
		title, err := boundedText(text, "title", maxTitleLen)
		if err != nil {
			return nil, err
		}
		input.Title = title
		canonical["title"] = title
		if raw, present := params["priority"]; present {
			priority, ok := raw.(string)
			if !ok {
				return nil, fail("invalid_params")
			}
			checked, err := checkPriority(priority)
			if err != nil {
				return nil, err
			}
			input.Priority = checked
			canonical["priority"] = checked
		}
		payload.propose = input
		payload.canonical = map[string]any{"tool": name, "input": canonical}
	case "bfb_submit_result":
		input, canonical, err := ValidateSubmitInput(params)
		if err != nil {
			return nil, err
		}
		payload.submit = input
		payload.canonical = map[string]any{"tool": name, "input": canonical}
	default:
		return nil, fail("method_not_found")
	}
	return payload, nil
}

func (host *Host) offline(name string, payload *validatedWrite, requestID string, boundary Boundary) (any, error) {
	if host.policy.Decide(name) != OfflinePending {
		return nil, fail("offline_rejected")
	}
	now := host.now().UTC().Truncate(time.Microsecond)
	operation := PendingOperation{
		RequestID:       requestID,
		Tool:            name,
		Boundary:        boundary,
		SessionID:       host.capability.SessionID(),
		Principal:       host.principal,
		Grant:           host.grant,
		ExpectedVersion: payload.version,
		CapturedAt:      now.Format(time.RFC3339Nano),
		ExpiresAt:       now.Add(pendingTTLHours * time.Hour).Format(time.RFC3339Nano),
		PolicyDecision:  string(OfflinePending),
	}
	return stagePending(host.journal, payload.canonical, operation)
}

// stagePending stores one validated offline operation idempotently and
// returns its pending_sync receipt. Repeats return the original receipt or
// the stored terminal outcome instead of duplicating the effect.
func stagePending(journal Journal, canonical map[string]any, operation PendingOperation) (any, error) {
	if journal == nil {
		return nil, fail("offline_rejected")
	}
	if result, code, ok, err := journal.Outcome(operation.RequestID); err == nil && ok {
		if code != "" {
			return nil, replayCodeFailure(code)
		}
		return result, nil
	}
	if existing, ok, err := journal.Pending(operation.RequestID); err == nil && ok {
		return pendingOutcome(existing), nil
	}
	if count, err := journal.CountForRun(operation.Boundary.RunID); err != nil || count >= maxPendingPerRun {
		return nil, fail("request_rejected")
	}
	encoded, err := json.Marshal(canonical)
	if err != nil || len(encoded) > 4096 {
		return nil, fail("request_rejected")
	}
	operation.PayloadHash = hashHex(encoded)
	operation.PayloadJSON = string(encoded)
	operation.CaptureProof = captureProof(operation)
	if _, err := journal.Store(operation); err != nil {
		return nil, fail("internal_error")
	}
	stored, ok, err := journal.Pending(operation.RequestID)
	if err != nil || !ok {
		return nil, fail("internal_error")
	}
	return pendingOutcome(stored), nil
}

// replayCodeFailure maps a terminal replay reason back to a bounded MCP failure.
func replayCodeFailure(reason string) error {
	switch reason {
	case "stale_version":
		return fail("stale_version")
	case "revoked":
		return fail("revoked")
	case "execution_ended":
		return fail("assignment_ended")
	case "result_terminal":
		return fail("capability_closed")
	case "policy_changed", "forbidden", "policy_rejected":
		return fail("policy_rejected")
	case "expired":
		return fail("offline_rejected")
	default:
		return fail("request_rejected")
	}
}

func pendingOutcome(operation PendingOperation) map[string]any {
	return map[string]any{
		"status":     "pending_sync",
		"request_id": operation.RequestID,
		"tool":       operation.Tool,
		"expires_at": operation.ExpiresAt,
	}
}

func hashHex(data []byte) string {
	digest := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func captureProof(operation PendingOperation) string {
	canonical := fmt.Sprintf("%s|%s|%s|%s|%s|%s|%d|%s|%s|%s",
		operation.RequestID, operation.Tool,
		operation.Boundary.WorkspaceID, operation.Boundary.ProjectID,
		operation.Boundary.TaskID, operation.Boundary.RunID,
		operation.ExpectedVersion, operation.PayloadHash,
		operation.SessionID, operation.CapturedAt)
	return hashHex([]byte(canonical))
}

// ABOUTME: Declares the L08-backed work transport behind every local MCP tool effect.
// ABOUTME: Separates online reads/writes from authority rechecks so offline tests stay honest.

package localmcp

import (
	"context"
)

// ContextItem is one agent-visible context record with its immutable version.
type ContextItem struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Body        string `json:"body"`
	Version     int64  `json:"version"`
	Audience    string `json:"audience"`
	ContentHash string `json:"content_hash"`
	CreatedAt   string `json:"created_at"`
}

// ContextDelivery records the immutable version/hash/time/run of a retrieval.
type ContextDelivery struct {
	ContextVersion int64  `json:"context_version"`
	ContentHash    string `json:"content_hash"`
	DeliveredAt    string `json:"delivered_at"`
	RunID          string `json:"run_id"`
}

// TaskView is the agent-visible subset of a task. Human-only context is never
// included; the transport must not populate fields outside this struct.
type TaskView struct {
	ID              string `json:"id"`
	ProjectID       string `json:"project_id"`
	State           string `json:"state"`
	Priority        string `json:"priority"`
	Title           string `json:"title"`
	Punchline       string `json:"punchline"`
	ResourceVersion int64  `json:"resource_version"`
}

// UpdateTaskInput carries only the permitted mutation fields. State,
// priority, due, owner, and promotion fields do not exist here by design.
type UpdateTaskInput struct {
	ExpectedVersion int64
	Title           *string
	Punchline       *string
}

// CommentResult is the committed idempotent outcome of a comment or progress write.
type CommentResult struct {
	ID string `json:"id"`
}

// ProposeTaskInput carries a root proposal or a bounded child creation.
type ProposeTaskInput struct {
	ParentTaskID *string
	Title        string
	Priority     string
}

// ProposeTaskResult is the committed idempotent outcome of a proposal.
type ProposeTaskResult struct {
	ID    string `json:"id"`
	State string `json:"state"`
}

// WorkTransport executes tool effects against current cloud state. Production
// goes through the L08 channel client; tests inject fakes. Every method
// rechecks current authorization and returns bounded *Error failures.
type WorkTransport interface {
	// Online reports whether the cloud channel is currently reachable.
	Online() bool
	// GetContext returns scoped agent context and records its delivery.
	GetContext(ctx context.Context, boundary Boundary) ([]ContextItem, ContextDelivery, error)
	// GetTask returns the agent-visible task view.
	GetTask(ctx context.Context, boundary Boundary) (TaskView, error)
	// UpdateTask applies permitted fields with an optimistic version check.
	UpdateTask(ctx context.Context, boundary Boundary, input UpdateTaskInput, requestID string) (TaskView, error)
	// AddComment appends a discussion comment attributed to the agent run.
	AddComment(ctx context.Context, boundary Boundary, body string, requestID string) (CommentResult, error)
	// ReportProgress publishes a bounded progress checkpoint.
	ReportProgress(ctx context.Context, boundary Boundary, summary string, percent *float64, confidence *float64, requestID string) (CommentResult, error)
	// ProposeTask creates a proposed root or policy-bounded child task.
	ProposeTask(ctx context.Context, boundary Boundary, input ProposeTaskInput, requestID string) (ProposeTaskResult, error)
	// RequestAttention commits a typed human-decision request for the run.
	RequestAttention(ctx context.Context, boundary Boundary, input AttentionRequest, requestID string) (AttentionRecord, error)
	// GetAttention returns the committed metadata for one of the run's own
	// requests. Records outside the run boundary report not_found.
	GetAttention(ctx context.Context, boundary Boundary, attentionID string) (AttentionRecord, error)
}

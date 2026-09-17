// ABOUTME: Supplies deterministic doubles for assignments, bindings, authority, and transport.
// ABOUTME: Uses synthetic identities only; no double reaches the network or the daemon database.

package localmcp

import (
	"context"
	"fmt"
	"sync"
	"time"
)

var (
	syntheticBoundary = Boundary{
		WorkspaceID: "01SYNTHETICWS00000000000001",
		ProjectID:   "01SYNTHETICPR00000000000001",
		TaskID:      "01SYNTHETICTA00000000000001",
		RunID:       "01SYNTHETICRU00000000000001",
		RunnerID:    "01SYNTHETICRN00000000000001",
		CheckoutID:  "01SYNTHETICCO00000000000001",
		ExecutionID: "01SYNTHETICEX00000000000001",
		Generation:  7,
	}
	syntheticCorrelation = "synthetic-correlation-token-for-tests-only-001"
	syntheticSession     = "synthetic-provider-session-001"
	syntheticTime        = time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
)

type fakeAssignments struct {
	mutex  sync.Mutex
	record AssignmentRecord
	err    error
}

func syntheticAssignment() AssignmentRecord {
	return AssignmentRecord{
		Known:            true,
		Active:           true,
		Boundary:         syntheticBoundary,
		CorrelationToken: syntheticCorrelation,
		ProviderPID:      4242,
		ProviderStart:    "synthetic-start-4242",
		OwnedGroupID:     4242,
	}
}

func (fake *fakeAssignments) Lookup(_ context.Context, executionID string, generation int64) (AssignmentRecord, error) {
	fake.mutex.Lock()
	defer fake.mutex.Unlock()
	if fake.err != nil {
		return AssignmentRecord{}, fake.err
	}
	if executionID != fake.record.Boundary.ExecutionID || generation != fake.record.Boundary.Generation {
		return AssignmentRecord{}, fail("assignment_unknown")
	}
	return fake.record, nil
}

type fakeBindings struct {
	mutex   sync.Mutex
	binding SessionBinding
	bound   bool
}

func (fake *fakeBindings) ObservedBinding(_ context.Context, ref AssignmentRef) (SessionBinding, error) {
	fake.mutex.Lock()
	defer fake.mutex.Unlock()
	if !fake.bound {
		return SessionBinding{}, ErrSessionNotBound
	}
	return fake.binding, nil
}

func (fake *fakeBindings) setBound(session string, ref AssignmentRef) {
	fake.mutex.Lock()
	defer fake.mutex.Unlock()
	fake.bound = true
	fake.binding = SessionBinding{
		ExecutionID:          ref.ExecutionID,
		AssignmentGeneration: ref.AssignmentGeneration,
		RunID:                ref.RunID,
		ObservedSessionID:    session,
		ObservedAt:           syntheticTime,
	}
}

type fakeAuthority struct {
	mutex sync.Mutex
	state AuthorityState
	err   error
}

func (fake *fakeAuthority) Current(_ context.Context, _ Boundary) (AuthorityState, error) {
	fake.mutex.Lock()
	defer fake.mutex.Unlock()
	return fake.state, fake.err
}

type fakeTransport struct {
	mutex     sync.Mutex
	online    bool
	task      TaskView
	items     []ContextItem
	updated   []UpdateTaskInput
	commented []string
	progress  []string
	proposed  []ProposeTaskInput
	attention map[string]*AttentionRecord
	attnRun   map[string]string
	attnSeq   int
	seen      map[string]any
	calls     map[string]int
	failCode  string
}

func attentionRole(kind string) string {
	switch kind {
	case "clarification", "review":
		return "reviewer"
	case "blocker":
		return "member"
	default:
		return "owner"
	}
}

func syntheticTransport() *fakeTransport {
	return &fakeTransport{
		online: true,
		task: TaskView{
			ID: syntheticBoundary.TaskID, ProjectID: syntheticBoundary.ProjectID,
			State: "active", Priority: "P1", Title: "Synthetic task",
			Punchline: "Synthetic punchline", ResourceVersion: 3,
		},
		items: []ContextItem{
			{ID: "01SYNTHETICCT00000000000001", Kind: "brief", Body: "Synthetic brief", Version: 1, Audience: "agent", ContentHash: "sha256:synthetic-brief", CreatedAt: "2026-09-17T11:00:00Z"},
			{ID: "01SYNTHETICCT00000000000002", Kind: "acceptance", Body: "Synthetic acceptance", Version: 2, Audience: "both", ContentHash: "sha256:synthetic-acceptance", CreatedAt: "2026-09-17T11:05:00Z"},
		},
		seen:      make(map[string]any),
		calls:     make(map[string]int),
		attention: make(map[string]*AttentionRecord),
		attnRun:   make(map[string]string),
	}
}

func (fake *fakeTransport) dedupe(requestID string, build func() any) (any, error) {
	fake.mutex.Lock()
	defer fake.mutex.Unlock()
	if result, ok := fake.seen[requestID]; ok {
		return result, nil
	}
	fake.calls[requestID]++
	if fake.failCode != "" {
		return nil, fail(fake.failCode)
	}
	result := build()
	fake.seen[requestID] = result
	return result, nil
}

func (fake *fakeTransport) Online() bool { return fake.online }

func (fake *fakeTransport) GetContext(_ context.Context, boundary Boundary) ([]ContextItem, ContextDelivery, error) {
	fake.mutex.Lock()
	defer fake.mutex.Unlock()
	if !fake.online {
		return nil, ContextDelivery{}, fail("offline_rejected")
	}
	return fake.items, ContextDelivery{ContextVersion: 2, ContentHash: "sha256:synthetic-delivery", DeliveredAt: syntheticTime.Format(time.RFC3339Nano), RunID: boundary.RunID}, nil
}

func (fake *fakeTransport) GetTask(_ context.Context, _ Boundary) (TaskView, error) {
	fake.mutex.Lock()
	defer fake.mutex.Unlock()
	if !fake.online {
		return TaskView{}, fail("offline_rejected")
	}
	return fake.task, nil
}

func (fake *fakeTransport) UpdateTask(_ context.Context, _ Boundary, input UpdateTaskInput, requestID string) (TaskView, error) {
	updated, err := fake.dedupe(requestID, func() any {
		next := fake.task
		if input.Title != nil {
			next.Title = *input.Title
		}
		if input.Punchline != nil {
			next.Punchline = *input.Punchline
		}
		next.ResourceVersion = input.ExpectedVersion + 1
		fake.task = next
		fake.updated = append(fake.updated, input)
		return next
	})
	if err != nil {
		return TaskView{}, err
	}
	return updated.(TaskView), nil
}

func (fake *fakeTransport) AddComment(_ context.Context, _ Boundary, body string, requestID string) (CommentResult, error) {
	result, err := fake.dedupe(requestID, func() any {
		fake.commented = append(fake.commented, body)
		return CommentResult{ID: fmt.Sprintf("comment-%d", len(fake.commented))}
	})
	if err != nil {
		return CommentResult{}, err
	}
	return result.(CommentResult), nil
}

func (fake *fakeTransport) ReportProgress(_ context.Context, _ Boundary, summary string, _ *float64, _ *float64, requestID string) (CommentResult, error) {
	result, err := fake.dedupe(requestID, func() any {
		fake.progress = append(fake.progress, summary)
		return CommentResult{ID: fmt.Sprintf("progress-%d", len(fake.progress))}
	})
	if err != nil {
		return CommentResult{}, err
	}
	return result.(CommentResult), nil
}

func (fake *fakeTransport) RequestAttention(_ context.Context, boundary Boundary, input AttentionRequest, requestID string) (AttentionRecord, error) {
	result, err := fake.dedupe(requestID, func() any {
		fake.attnSeq++
		record := &AttentionRecord{
			ID: fmt.Sprintf("attention-%d", fake.attnSeq), Kind: input.Kind,
			State: "open", Question: input.Question, RequiredRole: attentionRole(input.Kind),
			Blocking: input.Blocking, ResourceVersion: 1,
			RequestedAt: syntheticTime.Format(time.RFC3339Nano),
		}
		fake.attention[record.ID] = record
		fake.attnRun[record.ID] = boundary.RunID
		return *record
	})
	if err != nil {
		return AttentionRecord{}, err
	}
	return result.(AttentionRecord), nil
}

func (fake *fakeTransport) GetAttention(_ context.Context, boundary Boundary, attentionID string) (AttentionRecord, error) {
	fake.mutex.Lock()
	defer fake.mutex.Unlock()
	if !fake.online {
		return AttentionRecord{}, fail("offline_rejected")
	}
	record, ok := fake.attention[attentionID]
	if !ok || fake.attnRun[attentionID] != boundary.RunID {
		return AttentionRecord{}, fail("not_found")
	}
	return *record, nil
}

// answerAttention commits a human answer inside the double. Tests drive the
// answering side through this hook; the host under test only ever reads.
func (fake *fakeTransport) answerAttention(id, answer string) {
	fake.mutex.Lock()
	defer fake.mutex.Unlock()
	if record, ok := fake.attention[id]; ok && record.State == "open" {
		record.State = "answered"
		record.Answer = answer
		record.ResourceVersion++
		record.AnsweredAt = syntheticTime.Format(time.RFC3339Nano)
		record.FirstResponseAt = record.AnsweredAt
	}
}

func (fake *fakeTransport) ProposeTask(_ context.Context, boundary Boundary, input ProposeTaskInput, requestID string) (ProposeTaskResult, error) {
	if input.ParentTaskID == nil {
		return ProposeTaskResult{}, fail("policy_rejected")
	}
	if *input.ParentTaskID != boundary.TaskID {
		return ProposeTaskResult{}, fail("boundary_escape")
	}
	result, err := fake.dedupe(requestID, func() any {
		fake.proposed = append(fake.proposed, input)
		return ProposeTaskResult{ID: fmt.Sprintf("task-%d", len(fake.proposed)), State: "ready"}
	})
	if err != nil {
		return ProposeTaskResult{}, err
	}
	return result.(ProposeTaskResult), nil
}

type fakeReplayPolicy struct{ allow bool }

func (fake fakeReplayPolicy) CurrentAllow(_ context.Context, _ string, _ Boundary) bool {
	return fake.allow
}

func syntheticFacts() PeerFacts {
	return PeerFacts{UID: 501, PID: 4242, StartIdentity: "synthetic-start-4242", GroupID: 4242}
}

func testHost(record AssignmentRecord, bindings *fakeBindings, authority *fakeAuthority, transport *fakeTransport, journal Journal) (*Capability, *Host) {
	if authority == nil {
		authority = &fakeAuthority{}
	}
	if bindings == nil {
		bindings = &fakeBindings{}
	}
	capability := NewCapability(record.Boundary, bindings, authority)
	host := NewHost(HostDeps{
		Capability: capability,
		Transport:  transport,
		Journal:    journal,
		Policy:     DefaultOfflinePolicy{AllowPending: true},
		Principal:  "agent_run:" + record.Boundary.RunID,
		Grant:      "synthetic-grant",
		Now:        func() time.Time { return syntheticTime },
	})
	return capability, host
}

// ABOUTME: Proves atomic session binding, duplicate suppression and capture-window fencing.
// ABOUTME: Races concurrent first sessions and rejects mismatched or late hooks visibly.

package journal

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

const testExecution = "01JBFB0EXECXXXX00000000000"
const testRunner = "01JBFB0RVNNER1D00000000000"

func seedOne(t *testing.T, assignments *fakeAssignments, execution, runner, token string) {
	t.Helper()
	assignments.seed(testAssignment(execution, runner, token, 1))
}

func TestFirstSessionRaceBindsExactlyOne(t *testing.T) {
	_, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	seedOne(t, assignments, testExecution, testRunner, token)
	registry := testRegistry(t)

	const racers = 16
	var workers sync.WaitGroup
	receipts := make([]Receipt, racers)
	for index := range racers {
		workers.Add(1)
		go func() {
			defer workers.Done()
			receipt, err := store.Ingest(context.Background(), assignments, registry, HookInput{
				Provider: "fake", Raw: hookRaw("session_started", fmt.Sprintf("racer-%d", index), ""),
				ExecutionID: testExecution, Generation: 1, Token: token, CapturedAt: testBase.Add(time.Second),
			}, testBase.Add(time.Second))
			if err != nil {
				t.Error(err)
				return
			}
			receipts[index] = receipt
		}()
	}
	workers.Wait()
	accepted, quarantined := 0, 0
	for _, receipt := range receipts {
		switch receipt.Status {
		case "accepted":
			accepted++
		case "quarantined":
			if receipt.Code != "session_conflict" {
				t.Fatalf("unexpected quarantine %q", receipt.Code)
			}
			quarantined++
		default:
			t.Fatalf("unexpected receipt %+v", receipt)
		}
	}
	if accepted != 1 || quarantined != racers-1 {
		t.Fatalf("race bound %d sessions, quarantined %d", accepted, quarantined)
	}
	binding, err := store.BoundSession(context.Background(), testExecution, 1)
	if err != nil || !strings.HasPrefix(binding.SessionID, "racer-") || binding.Provider != "fake" {
		t.Fatalf("binding lost: %+v %v", binding, err)
	}
	if journalCount(t, store) != 1 || quarantineCount(t, store) != racers-1 {
		t.Fatal("journal/quarantine counts mismatch the race outcome")
	}
}

func TestDuplicateSessionStartMatchesBinding(t *testing.T) {
	_, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	seedOne(t, assignments, testExecution, testRunner, token)
	registry := testRegistry(t)

	first := ingest(t, store, assignments, registry, testExecution, testRunner, token, "fake", hookRaw("session_started", "sess-1", "src-1"), testBase.Add(time.Second))
	if first.Status != "accepted" {
		t.Fatalf("first session: %+v", first)
	}
	for _, raw := range [][]byte{hookRaw("session_started", "sess-1", "src-1"), hookRaw("session_started", "sess-1", "src-2"), hookRaw("session_started", "sess-1", "")} {
		receipt := ingest(t, store, assignments, registry, testExecution, testRunner, token, "fake", raw, testBase.Add(2*time.Second))
		if receipt.Status != "duplicate" || receipt.EventID != first.EventID {
			t.Fatalf("duplicate session created another event: %+v", receipt)
		}
	}
	competitor := ingest(t, store, assignments, registry, testExecution, testRunner, token, "fake", hookRaw("session_started", "sess-2", ""), testBase.Add(3*time.Second))
	if competitor.Status != "quarantined" || competitor.Code != "session_conflict" {
		t.Fatalf("competing session rebound the execution: %+v", competitor)
	}
	binding, err := store.BoundSession(context.Background(), testExecution, 1)
	if err != nil || binding.SessionID != "sess-1" {
		t.Fatalf("binding changed: %+v %v", binding, err)
	}
	if _, err := store.BoundSession(context.Background(), "01JBFB0EXECYYYY00000000000", 1); asCode(err) != "session_unbound" {
		t.Fatal("unbound execution invented a session")
	}
}

func TestSessionScopedHooksBindAndLaterHooksMustMatch(t *testing.T) {
	_, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	seedOne(t, assignments, testExecution, testRunner, token)
	registry := testRegistry(t)

	// Hooks run concurrently, so a turn may win the race against its own
	// SessionStart. The first session-scoped hook binds; nothing rebinds.
	early := ingest(t, store, assignments, registry, testExecution, testRunner, token, "fake", hookRaw("turn_started", "sess-early", "turn-1"), testBase.Add(time.Second))
	if early.Status != "accepted" {
		t.Fatalf("early turn lost the binding race: %+v", early)
	}
	binding, err := store.BoundSession(context.Background(), testExecution, 1)
	if err != nil || binding.SessionID != "sess-early" {
		t.Fatalf("binding missing: %+v %v", binding, err)
	}
	start := ingest(t, store, assignments, registry, testExecution, testRunner, token, "fake", hookRaw("session_started", "sess-early", ""), testBase.Add(2*time.Second))
	if start.Status != "accepted" {
		t.Fatalf("session start: %+v", start)
	}
	again := ingest(t, store, assignments, registry, testExecution, testRunner, token, "fake", hookRaw("turn_started", "sess-early", "turn-1"), testBase.Add(4*time.Second))
	if again.Status != "duplicate" || again.EventID != early.EventID {
		t.Fatalf("stable hook event journaled twice: %+v", again)
	}
	foreign := ingest(t, store, assignments, registry, testExecution, testRunner, token, "fake", hookRaw("turn_started", "sess-2", ""), testBase.Add(5*time.Second))
	if foreign.Status != "quarantined" || foreign.Code != "session_conflict" {
		t.Fatalf("foreign session hook accepted: %+v", foreign)
	}
}

func TestHookValidationIsVisibleAndSafe(t *testing.T) {
	_, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	seedOne(t, assignments, testExecution, testRunner, token)
	registry := testRegistry(t)
	ctx := context.Background()

	receipt, err := store.Ingest(ctx, assignments, registry, HookInput{Provider: "fake", Raw: hookRaw("session_started", "s", ""), ExecutionID: testExecution, Generation: 1, Token: "wrong-token", CapturedAt: testBase}, testBase)
	if err != nil || receipt.Status != "rejected" || receipt.Code != "correlation_rejected" {
		t.Fatalf("bad correlation: %+v %v", receipt, err)
	}
	receipt, err = store.Ingest(ctx, assignments, registry, HookInput{Provider: "fake", Raw: hookRaw("session_started", "s", ""), ExecutionID: testExecution, Generation: 2, Token: token, CapturedAt: testBase}, testBase)
	if err != nil || receipt.Status != "rejected" || receipt.Code != "unknown_assignment" {
		t.Fatalf("bad generation: %+v %v", receipt, err)
	}
	receipt, err = store.Ingest(ctx, assignments, registry, HookInput{Provider: "claude", Raw: hookRaw("session_started", "s", ""), ExecutionID: testExecution, Generation: 1, Token: token, CapturedAt: testBase}, testBase)
	if err != nil || receipt.Status != "rejected" || receipt.Code != "provider_mismatch" {
		t.Fatalf("provider confusion: %+v %v", receipt, err)
	}
	receipt, err = store.Ingest(ctx, assignments, registry, HookInput{Provider: "unknown", Raw: hookRaw("session_started", "s", ""), ExecutionID: testExecution, Generation: 1, Token: token, CapturedAt: testBase}, testBase)
	if err != nil || receipt.Status != "rejected" || receipt.Code != "provider_mismatch" {
		t.Fatalf("unknown provider: %+v %v", receipt, err)
	}
	claude := testAssignment(testExecution, testRunner, token, 1)
	claude.Provider = "claude"
	assignments.seed(claude)
	if _, err := store.Ingest(ctx, assignments, registry, HookInput{Provider: "claude", Raw: hookRaw("session_started", "s", ""), ExecutionID: testExecution, Generation: 1, Token: token, CapturedAt: testBase}, testBase); asCode(err) != "provider_event_invalid" {
		t.Fatalf("uncertified provider parsed: %v", err)
	}
	oversized := make([]byte, 65537)
	if _, err := store.Ingest(ctx, assignments, registry, HookInput{Provider: "fake", Raw: oversized, ExecutionID: testExecution, Generation: 1, Token: token, CapturedAt: testBase}, testBase); asCode(err) != "provider_event_invalid" {
		t.Fatalf("oversized hook accepted: %v", err)
	}
	if journalCount(t, store) != 0 || quarantineCount(t, store) != 0 {
		t.Fatal("rejected hooks left journal or quarantine rows")
	}
}

func TestDaemonKindsCannotPassThroughHooks(t *testing.T) {
	for _, kind := range []string{"execution_attached", "execution_detached", "execution_ended", "heartbeat", "launch_claimed", "launch_blocked"} {
		if _, ok := candidateKinds[kind]; ok {
			t.Fatalf("provider hook path can assert daemon kind %q", kind)
		}
	}
	for candidate, mapped := range candidateKinds {
		// tool_completed maps dynamically by outcome; every other candidate
		// needs a static journal kind.
		if mapped == "" && candidate != "tool_completed" {
			t.Fatalf("candidate %q has no journal mapping", candidate)
		}
	}
}

func TestFinalHookGraceReplay(t *testing.T) {
	_, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	assignment := testAssignment(testExecution, testRunner, token, 1)
	assignment.WindowEndsAt = localTimestamp(testBase.Add(30 * time.Second))
	assignments.seed(assignment)
	registry := testRegistry(t)

	inside := ingest(t, store, assignments, registry, testExecution, testRunner, token, "fake", hookRaw("session_started", "sess-1", ""), testBase.Add(20*time.Second))
	if inside.Status != "accepted" {
		t.Fatalf("grace-period hook rejected: %+v", inside)
	}
	late := ingest(t, store, assignments, registry, testExecution, testRunner, token, "fake", hookRaw("turn_started", "sess-1", ""), testBase.Add(40*time.Second))
	if late.Status != "rejected" || late.Code != "event_window_closed" {
		t.Fatalf("post-grace hook accepted: %+v", late)
	}
	early := ingest(t, store, assignments, registry, testExecution, testRunner, token, "fake", hookRaw("turn_started", "sess-1", ""), testBase.Add(-time.Second))
	if early.Status != "rejected" || early.Code != "event_window_closed" {
		t.Fatalf("pre-creation hook accepted: %+v", early)
	}
	if journalCount(t, store) != 1 {
		t.Fatal("late rejection invalidated the earlier envelope")
	}
	submission := decodeSubmission(t, store, inside.EventID)
	if submission.CaptureOrigin != "agent_reported" || submission.Kind != "session_started" {
		t.Fatalf("wrong envelope: %+v", submission)
	}
}

func TestConcurrentRunsKeepAttribution(t *testing.T) {
	_, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	const runs = 4
	executions := make([]string, runs)
	for index := range runs {
		executions[index] = fmt.Sprintf("01JBFB0EXECRN%d%012d", index, index)
		assignment := testAssignment(executions[index], testRunner, token, 1)
		assignments.seed(assignment)
	}
	registry := testRegistry(t)
	var workers sync.WaitGroup
	for _, execution := range executions {
		for hook := range 25 {
			workers.Add(1)
			go func() {
				defer workers.Done()
				session := "sess-" + execution[len(execution)-4:]
				if hook == 0 {
					ingest(t, store, assignments, registry, execution, testRunner, token, "fake", hookRaw("session_started", session, ""), testBase.Add(time.Second))
					return
				}
				ingest(t, store, assignments, registry, execution, testRunner, token, "fake", hookRaw("turn_started", session, fmt.Sprintf("turn-%d", hook)), testBase.Add(time.Duration(hook)*time.Second))
			}()
		}
	}
	workers.Wait()
	if got := journalCount(t, store); got != runs*25 {
		t.Fatalf("lost events across concurrent runs: %d", got)
	}
	seen := map[int64]bool{}
	rows, err := store.db.Query("SELECT source_sequence, execution_id FROM hook_journal")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	perExecution := map[string]int{}
	for rows.Next() {
		var sequence int64
		var execution string
		if err := rows.Scan(&sequence, &execution); err != nil {
			t.Fatal(err)
		}
		if seen[sequence] {
			t.Fatalf("duplicate source sequence %d", sequence)
		}
		seen[sequence] = true
		perExecution[execution]++
	}
	if len(seen) != runs*25 {
		t.Fatalf("source sequences are not unique: %d", len(seen))
	}
	for _, execution := range executions {
		if perExecution[execution] != 25 {
			t.Fatalf("run %s has %d events", execution, perExecution[execution])
		}
	}
}

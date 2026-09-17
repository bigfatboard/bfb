// ABOUTME: Builds the deterministic D02 harness: real fake-provider binary, kit planner, scripted authority/runner.
// ABOUTME: Every fault is scripted in-process; no credential, network, or repository mutation is possible here.

package discussion_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/discussion"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/fake"
	_ "modernc.org/sqlite"
)

var fakeExecutable string

func TestMain(m *testing.M) {
	root, err := os.MkdirTemp("", "bfb-discussion-test-")
	if err != nil {
		panic(err)
	}
	fakeExecutable = filepath.Join(root, "provider")
	build := exec.Command("go", "build", "-o", fakeExecutable, "../../cmd/bfb-fake-provider")
	if output, err := build.CombinedOutput(); err != nil {
		_, _ = os.Stderr.Write(output)
		panic(err)
	}
	code := m.Run()
	_ = os.RemoveAll(root)
	os.Exit(code)
}

// uid returns a deterministic valid ULID for sequence n.
func uid(n int) string { return fmt.Sprintf("01%024d", n) }

func nowAt(n int) string {
	return time.Date(2026, 9, 17, 12, 0, n, 0, time.UTC).Format(time.RFC3339Nano)
}

func openStore(t *testing.T) *discussion.Store {
	t.Helper()
	store, err := discussion.OpenStore(filepath.Join(t.TempDir(), "delivery.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

// fakeAuthority scripts current human authorization per discussion.
type fakeAuthority struct {
	mu      sync.Mutex
	revoked map[string]bool
	stopped map[string]bool
	err     map[string]error
}

func newAuthority() *fakeAuthority {
	return &fakeAuthority{revoked: map[string]bool{}, stopped: map[string]bool{}, err: map[string]error{}}
}

func (authority *fakeAuthority) Authorize(_ context.Context, discussionID string) (discussion.AuthorityState, error) {
	authority.mu.Lock()
	defer authority.mu.Unlock()
	if err, ok := authority.err[discussionID]; ok {
		return discussion.AuthorityState{}, err
	}
	return discussion.AuthorityState{Revoked: authority.revoked[discussionID], Stopped: authority.stopped[discussionID]}, nil
}

// scriptedRunner serves one programmed outcome per turn ordinal.
type scriptedTurn struct {
	session string
	output  []byte
	err     error
	effect  bool
}

type fakeRunner struct {
	mu        sync.Mutex
	byOrdinal map[int]scriptedTurn
	calls     []discussion.TurnRequest
	seen      []provider.Invocation
}

func (runner *fakeRunner) RunTurn(_ context.Context, request discussion.TurnRequest, invocation provider.Invocation) (discussion.TurnResult, error) {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	runner.calls = append(runner.calls, request)
	runner.seen = append(runner.seen, invocation)
	scripted := runner.byOrdinal[request.Ordinal]
	if scripted.err != nil {
		if scripted.effect {
			return discussion.TurnResult{ProviderEffect: true}, scripted.err
		}
		return discussion.TurnResult{}, &discussion.NoEffectError{Reason: "spawn_refused"}
	}
	return discussion.TurnResult{ObservedSession: scripted.session, Output: scripted.output, ProviderEffect: true}, nil
}

func validOutput(recommendation string, sources ...string) []byte {
	agreement := []map[string]string{}
	for _, source := range sources {
		agreement = append(agreement, map[string]string{"message_id": source})
	}
	raw, _ := json.Marshal(map[string]any{
		"schema_version": 1, "recommendation": recommendation,
		"reasons": []string{"bounded rationale"}, "evidence": []any{},
		"agreement": agreement, "disagreements": []any{},
		"human_questions": []string{"human tradeoff?"},
	})
	return raw
}

// kitPlanner builds a KitPlanner around the real fake-provider binary.
func kitPlanner(t *testing.T, workdir string) *discussion.KitPlanner {
	t.Helper()
	executable := filepath.Join(t.TempDir(), "provider")
	raw, err := os.ReadFile(fakeExecutable)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executable, raw, 0700); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(config, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	registry, err := provider.NewRegistry([]provider.Descriptor{fake.Descriptor()})
	if err != nil {
		t.Fatal(err)
	}
	installation := provider.Installation{
		Executable:      executable,
		ConfigFiles:     []provider.ConfigSource{{Name: "user", Path: config}},
		IntegrationHash: provider.Hash([]byte("synthetic-integration")),
		Environment:     []string{},
	}
	fixed := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	probe, err := registry.Probe(context.Background(), "fake", installation, fixed)
	if err != nil {
		t.Fatal(err)
	}
	return &discussion.KitPlanner{
		Registry: registry,
		Probes:   map[string]provider.Probe{"fake": probe},
		Policy:   provider.Policy{AllowedCapabilities: fake.Capabilities()},
		Configs: map[string]generated.ExecutionConfig{
			"fake": {
				Provider: "fake", Mode: "headless", Model: "synthetic", Effort: "low",
				ApprovalPolicy: "never", FilesystemPolicy: "read_only",
				ContextInjection: "none", InitialTurnTransport: "provider_prompt",
				RequiredCapabilities: []string{"launch.headless"},
			},
		},
		Now: func() time.Time { return fixed },
	}
}

const checkoutA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const checkoutB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

type discussionFixture struct {
	store      *discussion.Store
	authority  *fakeAuthority
	runner     *fakeRunner
	planner    *discussion.KitPlanner
	discussion string
	run        [2]string
	workdir    string
}

// setupDiscussion freezes a two-participant discussion with distinct checkouts.
func setupDiscussion(t *testing.T, rounds int) *discussionFixture {
	t.Helper()
	ctx := context.Background()
	fixture := &discussionFixture{
		store:      openStore(t),
		authority:  newAuthority(),
		runner:     &fakeRunner{byOrdinal: map[int]scriptedTurn{}},
		discussion: uid(100),
		workdir:    t.TempDir(),
	}
	fixture.planner = kitPlanner(t, fixture.workdir)
	fixture.run = [2]string{uid(200), uid(201)}
	deadline := time.Date(2026, 9, 17, 13, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
	if err := fixture.store.CreateSchedule(ctx, fixture.discussion, rounds, deadline, nowAt(0)); err != nil {
		t.Fatal(err)
	}
	for slot, checkout := range []string{checkoutA, checkoutB} {
		if _, err := fixture.store.Acquire(ctx, fixture.discussion, slot, fixture.run[slot], "fake", checkout, "worker-one", nowAt(0)); err != nil {
			t.Fatal(err)
		}
	}
	return fixture
}

func (fixture *discussionFixture) request(slot, ordinal, key int, fresh bool, session string) discussion.TurnRequest {
	return discussion.TurnRequest{
		DiscussionID: fixture.discussion, TurnID: uid(300 + ordinal), DeliveryID: uid(400 + ordinal),
		Slot: slot, Ordinal: ordinal, Provider: "fake", WorkingDir: fixture.workdir,
		RunID: fixture.run[slot], ExecutionID: uid(500 + ordinal), Generation: 1,
		ObservedSession: session, Fresh: fresh,
		ExternalContext: []byte(`{"brief":"synthetic brief","peer":[]}`),
		Worker:          "worker-one", Fencing: 1, IdempotencyKey: uid(600 + key),
	}
}

func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil || discussion.Code(err) != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}

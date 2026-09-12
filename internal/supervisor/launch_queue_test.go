// ABOUTME: Drives the durable launch consumer through real checkout and provider preparation with synthetic cloud replies.
// ABOUTME: Proves single-use Terminal delivery, frozen-source restart checks and bounded nonblocking queue lifecycle.

package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/checkout"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/fake"
	"github.com/qdis/bfb/internal/runner"
)

type launchQueueFixture struct {
	store           *IntentStore
	local           *daemon.Store
	files           *AssignmentFiles
	service         *Service
	command         LocalCommand
	claim           generated.LaunchClaimResult
	installation    provider.Installation
	probe           provider.Probe
	root            string
	now             time.Time
	requests, opens int
	released        bool
}

func fixtureQueueBinary(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "fake-provider")
	command := exec.Command("go", "build", "-o", binary, "../../cmd/bfb-fake-provider")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("fake provider build: %v %s", err, output)
	}
	return binary
}

func fixtureLaunchQueue(t *testing.T, binary string) *launchQueueFixture {
	t.Helper()
	ctx := context.Background()
	store, local, claim, _ := fixtureIntents(t)
	root := t.TempDir()
	cwd := filepath.Join(root, "packages", "api")
	if err := os.MkdirAll(cwd, 0700); err != nil {
		t.Fatal(err)
	}
	for _, arguments := range [][]string{{"init", "--initial-branch=main"}, {"remote", "add", "origin", "https://github.com/synthetic/queue.git"}} {
		command := exec.Command("/usr/bin/git", arguments...)
		command.Dir, command.Env = root, []string{"PATH=/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null"}
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("fixture Git: %v %s", err, output)
		}
	}
	record, err := checkout.NewRegistry(local.DB).Link(ctx, checkout.LinkInput{
		WorkspaceID: claim.Assignment.WorkspaceId, RunnerID: claim.Assignment.RunnerId, ProjectID: claim.Assignment.ProjectId,
		Path: cwd, WorkspaceSubpath: "packages/api", RepositoryIdentity: "github.com/synthetic/queue", Label: "Synthetic launch queue",
	})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	installation := provider.Installation{Executable: filepath.Join(t.TempDir(), "provider"), IntegrationHash: provider.Hash(nil), Environment: NormalEnvironment(os.Environ()), ConfigFiles: []provider.ConfigSource{{Name: "user", Path: filepath.Join(t.TempDir(), "provider.json")}}}
	if err := os.WriteFile(installation.Executable, data, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(installation.ConfigFiles[0].Path, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	registry, err := provider.NewRegistry([]provider.Descriptor{fake.Descriptor()})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	probe, err := registry.Probe(ctx, "fake", installation, now)
	if err != nil {
		t.Fatal(err)
	}
	claim.Assignment.CreatedAt, claim.Specification.ExpiresAt = localTimestamp(now), localTimestamp(now.Add(120*time.Second))
	claim.LeaseExpiresAt = localTimestamp(now.Add(45 * time.Second))
	claim.Assignment.CheckoutId, claim.Specification.CheckoutId = record.Summary.CheckoutId, record.Summary.CheckoutId
	claim.Snapshot.PhysicalWorktreeHash = record.Summary.PhysicalWorktreeHash
	claim.Snapshot.RepositoryIdentityHash = provider.Hash([]byte(record.Summary.RepositoryIdentity))
	claim.Snapshot.RepositoryConfigHash = record.Summary.RepositoryConfigHash
	claim.Snapshot.ProviderVersion, claim.Snapshot.ProviderManifestId = probe.Version, probe.ManifestID
	policy := map[string]any{"allowed_providers": []string{"fake"}, "allow_agent_root_propose": false, "allow_pass_to_agent": true, "allow_run_overrides": false}
	claim.Snapshot.WorkspacePolicy, claim.Snapshot.ProjectPolicy, claim.Snapshot.RepositoryPolicy = policy, policy, policy
	claim.Specification.ExecutionConfig = generated.ExecutionConfig{Provider: "fake", Mode: "interactive", Model: "synthetic", Effort: "low", ApprovalPolicy: "never", FilesystemPolicy: "read_only", ContextInjection: "none", InitialTurnTransport: "provider_prompt", RequiredCapabilities: []string{"launch.interactive"}}
	claim.Snapshot.ExecutionConfig = claim.Specification.ExecutionConfig
	claim.Specification.ConfigSnapshotHash, err = snapshotHash(claim.Snapshot)
	if err != nil {
		t.Fatal(err)
	}
	files, err := OpenAssignmentFiles(local.Paths.Root)
	if err != nil {
		t.Fatal(err)
	}
	f := &launchQueueFixture{store: store, local: local, files: files, claim: claim, installation: installation, probe: probe, root: root, now: now}
	t.Cleanup(func() { _ = f.files.Close() })
	f.command = acceptFixture(t, store, claim, now)
	connection := &finalConnection{request: func(ctx context.Context, method, path string, body []byte) ([]byte, error) {
		f.requests++
		if method != "POST" {
			t.Fatal("unexpected method")
		}
		switch path {
		case "launch/claim":
			expected, _ := claimRequest(f.command)
			if string(body) != string(expected) {
				t.Fatal("claim request identity changed")
			}
			return encodedFixture(t, map[string]any{"state": "claimed", "claim": f.claim}), nil
		case "launch/reconcile":
			state := "reserved"
			if f.released {
				state = "released"
			}
			return encodedFixture(t, receiptFixture(f.claim, state)), nil
		case "launch/reject":
			return []byte(`{"state":"rejected"}`), nil
		case "leases/observe":
			var observation generated.CheckoutLeaseObservation
			if json.Unmarshal(body, &observation) != nil || observation.Operation != "release" || observation.Supervisor != nil {
				t.Fatal("unexpected lease operation")
			}
			f.released = true
			return []byte(`{"state":"released"}`), nil
		default:
			t.Fatal("unexpected cloud path", path)
			return nil, errors.New("unexpected request")
		}
	}}
	f.service = NewService(ServiceOptions{
		Now: func() time.Time { return f.now }, Providers: registry,
		Connection: func(id string) (runner.RunnerConnection, error) {
			if id != f.command.RunnerID {
				t.Fatal("selected another enrollment")
			}
			return connection, nil
		},
		Installation: func(context.Context, string) (provider.Installation, error) { return f.installation, nil },
		OpenTerminal: func(ctx context.Context, intent string) error {
			f.opens++
			assignment, err := f.store.ByIntent(ctx, intent)
			if err != nil || assignment.State != "offered" || assignment.Supervisor != nil || !terminalIntent.MatchString(intent) {
				t.Fatal("Terminal delivery preceded durable offer", err)
			}
			var preparation LaunchPreparation
			if err := f.files.directory.read(intent+".preparation.json", &preparation); err != nil || !preparation.matches(intent, assignment.ProviderIdentityHash, f.claim) {
				t.Fatal("Terminal delivery preceded authenticated preparation", err)
			}
			return nil
		},
	})
	f.service.paths = local.Paths
	return f
}

func (f *launchQueueFixture) process() error {
	return f.service.processLaunch(context.Background(), f.store, f.files, f.command)
}

func TestLaunchQueueOffersOnlyOnceAcrossRestartAndExpiredCleanup(t *testing.T) {
	f := fixtureLaunchQueue(t, fixtureQueueBinary(t))
	if err := f.process(); err != nil || f.opens != 1 || f.requests != 1 {
		t.Fatal("launch did not reach single-use Terminal delivery", err)
	}
	for range 4 {
		if err := f.process(); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.files.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.local.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := daemon.OpenStore(context.Background(), f.local.Paths)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	f.store = NewIntentStore(reopened.DB)
	f.files, err = OpenAssignmentFiles(f.local.Paths.Root)
	if err != nil {
		t.Fatal(err)
	}
	f.service = NewService(f.service.options)
	f.service.paths = f.local.Paths
	if err = f.process(); err != nil || f.opens != 1 || f.requests != 1 {
		t.Fatal("restart reclaimed or reoffered existing intent", err)
	}
	f.now = f.now.Add(3 * time.Minute)
	if err = f.process(); err != nil || !f.released || f.opens != 1 {
		t.Fatal("expired unregistered offer not safely settled", err)
	}
	current, _ := f.store.Command(context.Background(), f.command.RunnerID, f.command.ID)
	if current.State != "complete" {
		t.Fatal("expired offer left unresolved after confirmed cleanup")
	}
}

func TestLaunchQueueLostClaimReplyUsesOriginalRequestWithoutLocalEffect(t *testing.T) {
	f := fixtureLaunchQueue(t, fixtureQueueBinary(t))
	original, err := f.service.options.Connection(f.command.RunnerID)
	if err != nil {
		t.Fatal(err)
	}
	var lost []byte
	connection := &finalConnection{request: func(ctx context.Context, method, path string, body []byte) ([]byte, error) {
		if lost == nil {
			lost = append([]byte{}, body...)
			return nil, errors.New("synthetic accepted claim with lost reply")
		}
		if path == "launch/claim" && string(body) != string(lost) {
			t.Fatal("lost claim reply created a different request")
		}
		return original.Request(ctx, method, path, body)
	}}
	f.service.options.Connection = func(string) (runner.RunnerConnection, error) { return connection, nil }
	if err := f.process(); err == nil || f.opens != 0 {
		t.Fatal("lost claim reply produced a Terminal effect")
	}
	if assignment, err := f.store.ByCommand(context.Background(), f.command); err != nil || assignment != nil {
		t.Fatal("lost claim reply produced a local assignment", err)
	}
	if err := f.process(); err != nil || f.opens != 1 {
		t.Fatal("original claim retry did not recover its single launch", err)
	}
}

func TestExecutionCheckoutReturnsFreshGitFactsWithoutPersistingThem(t *testing.T) {
	f := fixtureLaunchQueue(t, fixtureQueueBinary(t))
	ctx := context.Background()
	registry := checkout.NewRegistry(f.local.DB)
	before, err := registry.Get(ctx, f.claim.Assignment.CheckoutId)
	if err != nil || before.Summary.Dirty {
		t.Fatal("fixture checkout was not initially clean", err)
	}
	if err := os.WriteFile(filepath.Join(f.root, "untracked.txt"), []byte("synthetic dirty state"), 0600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command("/usr/bin/git", "symbolic-ref", "HEAD", "refs/heads/synthetic-branch")
	command.Dir, command.Env = f.root, []string{"PATH=/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null"}
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("fixture branch: %v %s", err, output)
	}
	observed, err := checkCheckout(ctx, registry, generated.LocalExecutionAssignment{Claim: f.claim})
	if err != nil || !observed.Summary.Dirty || observed.Summary.Branch == nil || *observed.Summary.Branch != "synthetic-branch" || observed.Summary.Head != nil {
		t.Fatal("execution reused stale Git facts", err)
	}
	after, err := registry.Get(ctx, f.claim.Assignment.CheckoutId)
	if err != nil || string(encodedFixture(t, before.Summary)) != string(encodedFixture(t, after.Summary)) {
		t.Fatal("execution observation wrote the checkout registry", err)
	}
}

func TestLaunchPreflightFailuresBlockBeforeExecution(t *testing.T) {
	binary := fixtureQueueBinary(t)
	for _, fault := range []string{"moved_checkout", "headless", "version", "manifest", "unavailable", "consent_denied", "session_locked", "app_delivery_unknown", "resume"} {
		t.Run(fault, func(t *testing.T) {
			f := fixtureLaunchQueue(t, binary)
			expectedOpens := 0
			switch fault {
			case "moved_checkout":
				if err := os.Rename(f.root, f.root+"-moved"); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Rename(f.root+"-moved", f.root) })
			case "headless":
				f.claim.Specification.ExecutionConfig.Mode = "headless"
				f.claim.Snapshot.ExecutionConfig = f.claim.Specification.ExecutionConfig
			case "version":
				f.claim.Snapshot.ProviderVersion = "9.9.9"
			case "manifest":
				f.claim.Snapshot.ProviderManifestId = provider.Hash(nil)
			case "unavailable":
				f.service.options.Installation = localInstallationForLaunch
			case "consent_denied", "session_locked", "app_delivery_unknown":
				expectedOpens = 1
				f.service.options.OpenTerminal = func(context.Context, string) error { f.opens++; return failure(fault) }
			case "resume":
				f.claim.Specification.ResumeSession = map[string]any{"provider_session_id": daemon.NewRequestID(), "observed_session_id": "synthetic-session"}
			}
			var err error
			f.claim.Specification.ConfigSnapshotHash, err = snapshotHash(f.claim.Snapshot)
			if err != nil {
				t.Fatal(err)
			}
			if err = f.process(); err == nil || f.opens != expectedOpens || !f.released {
				t.Fatal("preflight failure did not block and release unstarted reservation", err)
			}
			if err = f.process(); err != nil || f.opens != expectedOpens {
				t.Fatal("failed launch was offered again", err)
			}
		})
	}
}

func TestLaunchRestartRevalidatesFrozenSourcesBeforeProbing(t *testing.T) {
	binary := fixtureQueueBinary(t)
	for _, fault := range []string{"unchanged", "missing_preparation", "binary", "configuration", "integration"} {
		t.Run(fault, func(t *testing.T) {
			f := fixtureLaunchQueue(t, binary)
			registry := f.service.options.Providers
			identity, err := registry.IdentityHash(f.probe)
			if err != nil {
				t.Fatal(err)
			}
			assignment, err := f.store.Issue(context.Background(), f.command, f.claim, identity, f.now)
			if err != nil {
				t.Fatal(err)
			}
			if fault != "missing_preparation" {
				if _, err = f.files.Prepare(assignment, registry, f.probe, f.root); err != nil {
					t.Fatal(err)
				}
			}
			canary := filepath.Join(t.TempDir(), "unexpected-probe")
			switch fault {
			case "binary", "missing_preparation":
				if err = os.WriteFile(f.installation.Executable, []byte("#!/bin/sh\ntouch '"+canary+"'\n"), 0700); err != nil {
					t.Fatal(err)
				}
			case "configuration":
				if err = os.WriteFile(f.installation.ConfigFiles[0].Path, []byte(`{"changed":true}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "integration":
				f.installation.IntegrationHash = provider.Hash([]byte("changed"))
			}
			err = f.process()
			if fault == "unchanged" {
				if err != nil || f.opens != 1 || f.requests != 0 {
					t.Fatal("unchanged prepared launch did not continue without reclaiming", err)
				}
			} else if err == nil || f.opens != 0 || !f.released {
				t.Fatal("changed or missing preparation reached Terminal", err)
			}
			if _, err = os.Stat(canary); !os.IsNotExist(err) {
				t.Fatal("replacement executable ran a version probe")
			}
		})
	}
}

func TestLaunchConsumerAcceptsBeforeIOAndBoundsWorkers(t *testing.T) {
	_, local, claim, now := fixtureIntents(t)
	started := make(chan string, 8)
	release := make(chan struct{})
	var active atomic.Int32
	connection := &finalConnection{request: func(ctx context.Context, _, path string, body []byte) ([]byte, error) {
		if path != "launch/claim" {
			return nil, errors.New("unexpected request")
		}
		var request generated.LaunchClaim
		if json.Unmarshal(body, &request) != nil {
			return nil, errors.New("invalid request")
		}
		if count := active.Add(1); count > 4 {
			t.Error("queue exceeded worker bound")
		}
		defer active.Add(-1)
		started <- request.LaunchId
		select {
		case <-ctx.Done():
		case <-release:
		}
		return nil, errors.New("synthetic lost claim response")
	}}
	service := NewService(ServiceOptions{Now: func() time.Time { return now }, Connection: func(string) (runner.RunnerConnection, error) { return connection, nil }})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	enrollment := runner.Enrollment{RunnerID: claim.Assignment.RunnerId, WorkspaceID: claim.Assignment.WorkspaceId}
	first := runner.CommandReference{ID: claim.Specification.LaunchId, Kind: "launch", ExpiresAt: claim.Specification.ExpiresAt}
	accepted := make(chan error, 1)
	go func() { accepted <- service.Accept(ctx, enrollment, first) }()
	stop, err := service.Start(ctx, local)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	select {
	case err := <-accepted:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("consumer acceptance waited on cloud I/O")
	}
	for range 3 {
		if err := service.Accept(ctx, enrollment, runner.CommandReference{ID: daemon.NewRequestID(), Kind: "launch", ExpiresAt: first.ExpiresAt}); err != nil {
			t.Fatal(err)
		}
	}
	for range 4 {
		select {
		case <-started:
		case <-ctx.Done():
			t.Fatal("independent pending commands were head-of-line blocked")
		}
	}
	fifth := runner.CommandReference{ID: daemon.NewRequestID(), Kind: "launch", ExpiresAt: first.ExpiresAt}
	if err := service.Accept(ctx, enrollment, fifth); err != nil {
		t.Fatal(err)
	}
	if _, err := NewIntentStore(local.DB).Command(ctx, enrollment.RunnerID, fifth.ID); err != nil {
		t.Fatal("acceptance did not durably store command")
	}
	// One blocked request returns; the fifth must proceed while three older
	// requests are still in flight and the failed command is in backoff.
	release <- struct{}{}
	select {
	case id := <-started:
		if id != fifth.ID {
			t.Fatal("queue retried failed command ahead of new pending work")
		}
	case <-ctx.Done():
		t.Fatal("available worker did not consume fifth command")
	}
	var stopped sync.WaitGroup
	stopped.Go(stop)
	stopped.Wait()
	if active.Load() != 0 {
		t.Fatal("shutdown left cloud workers running")
	}
	pending, err := NewIntentStore(local.DB).Pending(context.Background())
	if err != nil || len(pending) != 5 {
		t.Fatal("shutdown or lost claim replies discarded durable commands", err)
	}
}

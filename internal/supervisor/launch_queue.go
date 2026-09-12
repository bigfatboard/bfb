// ABOUTME: Processes the durable launch inbox with bounded workers and immutable single-use Terminal delivery.
// ABOUTME: Retries original cloud claims without replaying offered intents or bypassing cleanup and native ownership.

package supervisor

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/qdis/bfb/internal/checkout"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/runner"
)

// Test installations are compiled harness dependencies. A fake executable is
// never discovered from PATH, environment or a remote provider/path selector.
func localInstallationForLaunch(_ context.Context, name string) (provider.Installation, error) {
	if name != "claude" && name != "codex" && name != "grok" {
		return provider.Installation{}, failure("provider_unsupported")
	}
	path, err := exec.LookPath(name)
	if err != nil {
		return provider.Installation{}, failure("provider_unsupported")
	}
	return provider.Installation{Executable: path, Environment: NormalEnvironment(os.Environ()), IntegrationHash: provider.Hash(nil)}, nil
}

type commandKey struct{ runner, command string }
type commandRetry struct {
	next  time.Time
	delay time.Duration
}

func (service *Service) runQueue(ctx context.Context, store *IntentStore, files *AssignmentFiles) {
	// Registration-only harnesses do not configure a runner transport. Keep
	// their accepted records untouched until an execution consumer is present.
	if service.options.Connection == nil {
		<-ctx.Done()
		return
	}
	const concurrency = 4
	finished := make(chan commandKey, concurrency)
	inFlight := map[commandKey]bool{}
	retry := map[commandKey]commandRetry{}
	var workers sync.WaitGroup
	defer workers.Wait()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for ctx.Err() == nil {
		commands, err := store.Pending(ctx)
		if err == nil {
			pending := map[commandKey]bool{}
			for _, command := range commands {
				key := commandKey{command.RunnerID, command.ID}
				pending[key] = true
				if len(inFlight) == concurrency || inFlight[key] || time.Now().Before(retry[key].next) {
					continue
				}
				inFlight[key] = true
				workers.Go(func() {
					attempt, cancel := context.WithTimeout(ctx, 45*time.Second)
					defer cancel()
					err := service.processLaunch(attempt, store, files, command)
					if attempt.Err() == nil {
						_ = store.Wait(attempt, command, err)
					}
					finished <- key
				})
			}
			for key := range retry {
				if !pending[key] && !inFlight[key] {
					delete(retry, key)
				}
			}
		}
		select {
		case <-ctx.Done():
		case <-service.wake:
		case <-ticker.C:
		case key := <-finished:
			delete(inFlight, key)
			delay := max(5*time.Second, min(time.Minute, retry[key].delay*2))
			retry[key] = commandRetry{next: time.Now().Add(delay), delay: delay}
		}
	}
}

func (service *Service) processLaunch(ctx context.Context, store *IntentStore, files *AssignmentFiles, pending LocalCommand) error {
	command, err := store.Command(ctx, pending.RunnerID, pending.ID)
	if err != nil {
		return err
	}
	if command.State == "complete" || command.State == "containment_unknown" {
		return nil
	}
	if service.options.Connection == nil {
		return failure("daemon_offline")
	}
	connection, err := service.options.Connection(command.RunnerID)
	if err != nil || connection == nil {
		return failure("daemon_offline")
	}
	assignment, err := store.ByCommand(ctx, command)
	if err != nil {
		return err
	}
	if assignment != nil && assignment.Supervisor != nil {
		// Registered executions belong to native lifecycle observation; they
		// can never fall through to another claim, intent or Terminal open.
		return nil
	}
	if command.CleanupLockID != "" {
		return service.cleanupUnstarted(ctx, store, command, connection)
	}
	if assignment != nil {
		deadline, _ := time.Parse(time.RFC3339Nano, command.ExpiresAt)
		if !service.options.Now().Before(deadline) || assignment.State == "blocked" {
			return service.cleanupUnstarted(ctx, store, command, connection)
		}
		if assignment.State != "intent_ready" {
			return nil
		}
		return service.prepareLaunch(ctx, store, files, command, assignment.Claim, connection)
	}
	body, err := claimRequest(command)
	if err != nil {
		return err
	}
	data, err := requestLaunch(ctx, connection, "launch/claim", body)
	if err != nil {
		// No local effect has occurred. Retry the same durable claim; a lost
		// reply neither proves absence nor authorizes a fresh request identity.
		return err
	}
	claim, err := claimOutcome(data, command)
	if err != nil {
		return err
	}
	deadline, _ := time.Parse(time.RFC3339Nano, command.ExpiresAt)
	if claim == nil || !service.options.Now().Before(deadline) {
		return service.cleanupUnstarted(ctx, store, command, connection)
	}
	return service.prepareLaunch(ctx, store, files, command, *claim, connection)
}

func (service *Service) prepareLaunch(ctx context.Context, store *IntentStore, files *AssignmentFiles, command LocalCommand, claim generated.LaunchClaimResult, connection runner.RunnerConnection) error {
	if err := service.prepareAndOffer(ctx, store, files, command, claim); err != nil {
		if cleanupErr := service.cleanupUnstarted(ctx, store, command, connection); cleanupErr != nil {
			return cleanupErr
		}
		return err
	}
	return nil
}

func (service *Service) prepareAndOffer(ctx context.Context, store *IntentStore, files *AssignmentFiles, command LocalCommand, claim generated.LaunchClaimResult) error {
	if claim.Specification.ResumeSession != nil {
		return failure("provider_session_invalid")
	}
	if service.options.OpenTerminal == nil {
		return failure("app_unavailable")
	}
	config := claim.Specification.ExecutionConfig
	if config.Mode != "interactive" {
		return failure("provider_config_invalid")
	}
	record, err := checkCheckout(ctx, checkout.NewRegistry(store.db), generated.LocalExecutionAssignment{Claim: claim})
	if err != nil {
		return err
	}
	installation, err := service.options.Installation(ctx, string(config.Provider))
	if err != nil {
		return err
	}
	installation.Environment = NormalEnvironment(installation.Environment)
	registry := service.options.Providers
	probe, err := service.launchProbe(ctx, store, files, command, claim, installation, record.Location.GitRoot)
	if err != nil {
		return err
	}
	identity, err := registry.IdentityHash(probe)
	if err != nil || probe.Status != "healthy" || probe.Version != claim.Snapshot.ProviderVersion || probe.ManifestID != claim.Snapshot.ProviderManifestId {
		return failure("provider_changed")
	}
	plan, err := registry.PlanLaunch(probe, provider.LaunchInput{Config: config, WorkingDirectory: record.Location.WorkingDirectory}, provider.Policy{AllowedCapabilities: probe.Capabilities}, service.options.Now())
	if err != nil {
		return err
	}
	if len(plan.Invocation().Stdin) != 0 {
		return failure("provider_config_invalid")
	}
	assignment, err := store.Issue(ctx, command, claim, identity, service.options.Now())
	if err != nil {
		return err
	}
	if _, err = files.Prepare(assignment, registry, probe, record.Location.GitRoot); err != nil {
		return err
	}
	if err = registry.RevalidateSources(plan, service.options.Now()); err != nil {
		return err
	}
	if won, err := store.Offer(ctx, assignment.IntentID); err != nil || !won {
		return err
	}
	// Offer precedes the external effect even when cancellation or a lost app
	// reply makes delivery ambiguous. Registration and cleanup race atomically.
	delivery := service.options.OpenTerminal(ctx, assignment.IntentID)
	if delivery != nil {
		_ = store.DeliveryUnknown(ctx, assignment.IntentID)
	}
	return delivery
}

func (service *Service) launchProbe(ctx context.Context, store *IntentStore, files *AssignmentFiles, command LocalCommand, claim generated.LaunchClaimResult, installation provider.Installation, checkoutRoot string) (provider.Probe, error) {
	existing, err := store.ByCommand(ctx, command)
	if err != nil {
		return provider.Probe{}, err
	}
	if existing == nil {
		return service.options.Providers.Probe(ctx, string(claim.Specification.ExecutionConfig.Provider), installation, service.options.Now())
	}
	// Restart must authenticate the original source before even a version
	// probe. Missing preparation after issuance is not permission to recreate
	// it from whatever executable/configuration happens to be installed now.
	var preparation LaunchPreparation
	if existing.State != "intent_ready" || files.directory.read(existing.IntentID+".preparation.json", &preparation) != nil ||
		!preparation.matches(existing.IntentID, existing.ProviderIdentityHash, claim) || preparation.RevalidateArtifacts(service.paths.Root, claim.Assignment.RunExecutionId, checkoutRoot) != nil {
		return provider.Probe{}, failure("execution_assignment_invalid")
	}
	locations, err := installationLocations(installation)
	want, _ := json.Marshal(locations)
	actual, _ := json.Marshal(preparation.Provider)
	if err != nil || string(want) != string(actual) {
		return provider.Probe{}, failure("provider_changed")
	}
	return service.options.Providers.ProbeBound(ctx, string(claim.Specification.ExecutionConfig.Provider), installation, preparation.SourceHash, service.options.Now())
}

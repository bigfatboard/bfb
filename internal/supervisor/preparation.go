// ABOUTME: Freezes locally discovered provider locations and an execution-specific private artifact directory.
// ABOUTME: Keeps local paths out of RPC and excludes inherited environment or command arguments from durable preparation.

package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
	"golang.org/x/sys/unix"
)

var configurationName = regexp.MustCompile(`^[a-z][a-z0-9_.]{0,63}$`)

type installationFile struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type localInstallation struct {
	Executable      string             `json:"executable"`
	Configuration   []installationFile `json:"configuration"`
	IntegrationHash string             `json:"integration_hash"`
}

// LaunchPreparation is private on-disk state, never a wire payload or a plan.
// A fresh provider probe must still reproduce ProviderIdentityHash before use.
type LaunchPreparation struct {
	Version              int               `json:"version"`
	IntentID             string            `json:"intent_id"`
	ClaimHash            string            `json:"claim_hash"`
	ProviderIdentityHash string            `json:"provider_identity_hash"`
	SourceHash           string            `json:"source_hash"`
	Provider             localInstallation `json:"provider"`
	Artifacts            ArtifactDirectory `json:"artifacts"`
}

func localPath(path string) bool {
	return filepath.IsAbs(path) && filepath.Clean(path) == path && len(path) <= 4096 && utf8.ValidString(path) && !strings.ContainsFunc(path, unicode.IsControl)
}

func installationLocations(installation provider.Installation) (localInstallation, error) {
	local := localInstallation{Executable: installation.Executable, IntegrationHash: installation.IntegrationHash, Configuration: []installationFile{}}
	for _, source := range installation.ConfigFiles {
		local.Configuration = append(local.Configuration, installationFile{Name: source.Name, Path: source.Path})
	}
	slices.SortFunc(local.Configuration, func(a, b installationFile) int { return strings.Compare(a.Name, b.Name) })
	if !local.valid() {
		return localInstallation{}, failure("provider_config_invalid")
	}
	return local, nil
}

func (installation localInstallation) valid() bool {
	if !localPath(installation.Executable) || !worktreeDigest.MatchString(installation.IntegrationHash) || len(installation.Configuration) > 16 {
		return false
	}
	for index, source := range installation.Configuration {
		if !configurationName.MatchString(source.Name) || !localPath(source.Path) || index > 0 && installation.Configuration[index-1].Name >= source.Name {
			return false
		}
	}
	return true
}

// Installation reconstructs probe input using only this helper's normal local
// environment. No environment values are serialized in LaunchPreparation.
func (preparation LaunchPreparation) Installation(environment []string) provider.Installation {
	installation := provider.Installation{Executable: preparation.Provider.Executable, IntegrationHash: preparation.Provider.IntegrationHash, Environment: NormalEnvironment(environment)}
	for _, source := range preparation.Provider.Configuration {
		installation.ConfigFiles = append(installation.ConfigFiles, provider.ConfigSource{Name: source.Name, Path: source.Path})
	}
	return installation
}

func claimIdentity(claim generated.LaunchClaimResult) string {
	data, _ := json.Marshal(claim)
	return provider.Hash(data)
}

func (preparation LaunchPreparation) matches(intent, identity string, claim generated.LaunchClaimResult) bool {
	return preparation.Version == 1 && preparation.IntentID == intent && terminalIntent.MatchString(intent) && preparation.ClaimHash == claimIdentity(claim) &&
		preparation.ProviderIdentityHash == identity && worktreeDigest.MatchString(identity) && worktreeDigest.MatchString(preparation.SourceHash) && preparation.Provider.valid()
}

func (files *AssignmentFiles) Prepare(assignment LocalAssignment, registry *provider.Registry, probe provider.Probe, checkoutRoot string) (LaunchPreparation, error) {
	identity, err := registry.IdentityHash(probe)
	if err != nil || identity != assignment.ProviderIdentityHash {
		return LaunchPreparation{}, failure("provider_changed")
	}
	installation, source, err := registry.InstallationSource(probe)
	if err != nil {
		return LaunchPreparation{}, err
	}
	return files.prepare(assignment, installation, source, checkoutRoot)
}

func (files *AssignmentFiles) prepare(assignment LocalAssignment, installation provider.Installation, source, checkoutRoot string) (LaunchPreparation, error) {
	if !files.directory.writable || assignment.State != "intent_ready" || assignment.Supervisor != nil || !terminalIntent.MatchString(assignment.IntentID) || !worktreeDigest.MatchString(assignment.ProviderIdentityHash) {
		return LaunchPreparation{}, failure("execution_assignment_invalid")
	}
	claim := assignment.Claim
	if err := validateClaim(claim, claim.Assignment.WorkspaceId, claim.Assignment.RunnerId, claim.Specification.LaunchId, claim.Specification.ExpiresAt); err != nil {
		return LaunchPreparation{}, err
	}
	local, err := installationLocations(installation)
	if err != nil || !worktreeDigest.MatchString(source) {
		return LaunchPreparation{}, failure("provider_config_invalid")
	}
	name := assignment.IntentID + ".preparation.json"
	var existing LaunchPreparation
	if err := files.directory.read(name, &existing); err == nil {
		want, _ := json.Marshal(local)
		actual, _ := json.Marshal(existing.Provider)
		if !existing.matches(assignment.IntentID, assignment.ProviderIdentityHash, claim) || existing.SourceHash != source || string(want) != string(actual) || existing.RevalidateArtifacts(filepath.Dir(files.directory.file.Name()), claim.Assignment.RunExecutionId, checkoutRoot) != nil {
			return LaunchPreparation{}, failure("execution_assignment_invalid")
		}
		return existing, nil
	} else if !errors.Is(err, unix.ENOENT) {
		return LaunchPreparation{}, failure("execution_assignment_invalid")
	}
	artifacts, err := openArtifacts(filepath.Dir(files.directory.file.Name()), claim.Assignment.RunExecutionId, checkoutRoot, true)
	if err != nil {
		return LaunchPreparation{}, err
	}
	preparation := LaunchPreparation{Version: 1, IntentID: assignment.IntentID, ClaimHash: claimIdentity(claim), ProviderIdentityHash: assignment.ProviderIdentityHash, SourceHash: source, Provider: local, Artifacts: artifacts}
	if err := files.directory.createOnce(name, preparation); err != nil {
		return LaunchPreparation{}, err
	}
	return preparation, nil
}

func (files *AssignmentFiles) ReadPreparation(assignment generated.LocalExecutionAssignment, checkoutRoot string) (LaunchPreparation, error) {
	if err := validateLocalAssignment(assignment); err != nil {
		return LaunchPreparation{}, err
	}
	var preparation LaunchPreparation
	if err := files.directory.read(assignment.TerminalIntentId+".preparation.json", &preparation); err != nil || !preparation.matches(assignment.TerminalIntentId, assignment.ProviderIdentityHash, assignment.Claim) {
		return LaunchPreparation{}, failure("execution_assignment_invalid")
	}
	if err := preparation.RevalidateArtifacts(filepath.Dir(files.directory.file.Name()), assignment.Claim.Assignment.RunExecutionId, checkoutRoot); err != nil {
		return LaunchPreparation{}, err
	}
	return preparation, nil
}

func (preparation LaunchPreparation) RevalidateArtifacts(root, execution, checkoutRoot string) error {
	current, err := openArtifacts(root, execution, checkoutRoot, false)
	if err != nil || current != preparation.Artifacts {
		return failure("execution_assignment_invalid")
	}
	return nil
}

func (preparation LaunchPreparation) Probe(ctx context.Context, registry *provider.Registry, assignment generated.LocalExecutionAssignment, environment []string, now time.Time) (provider.Probe, error) {
	if validateLocalAssignment(assignment) != nil || !preparation.matches(assignment.TerminalIntentId, assignment.ProviderIdentityHash, assignment.Claim) {
		return provider.Probe{}, failure("execution_assignment_invalid")
	}
	probe, err := registry.ProbeBound(ctx, string(assignment.Claim.Specification.ExecutionConfig.Provider), preparation.Installation(environment), preparation.SourceHash, now)
	if err != nil {
		return provider.Probe{}, err
	}
	identity, err := registry.IdentityHash(probe)
	snapshot := assignment.Claim.Snapshot
	if err != nil || identity != preparation.ProviderIdentityHash || probe.Status != "healthy" || probe.Version != snapshot.ProviderVersion || probe.ManifestID != snapshot.ProviderManifestId {
		return provider.Probe{}, failure("provider_changed")
	}
	return probe, nil
}

// NormalEnvironment removes inherited BFB authority before probing or starting
// an execution. The provider kit validates the remaining local environment.
func NormalEnvironment(environment []string) []string {
	result := []string{}
	for _, entry := range environment {
		name, _, _ := strings.Cut(entry, "=")
		if !strings.HasPrefix(name, "BFB_") {
			result = append(result, entry)
		}
	}
	return result
}

func (preparation LaunchPreparation) Environment(assignment generated.LocalExecutionAssignment, normal []string) ([]string, error) {
	if validateLocalAssignment(assignment) != nil || !preparation.matches(assignment.TerminalIntentId, assignment.ProviderIdentityHash, assignment.Claim) || !localPath(preparation.Artifacts.Path) {
		return nil, failure("execution_assignment_invalid")
	}
	binding := assignment.Claim.Assignment
	environment := NormalEnvironment(normal)
	return append(environment,
		"BFB_WORKSPACE_ID="+binding.WorkspaceId, "BFB_PROJECT_ID="+binding.ProjectId,
		"BFB_TASK_ID="+binding.TaskId, "BFB_RUN_ID="+binding.RunId,
		"BFB_RUN_EXECUTION_ID="+binding.RunExecutionId, "BFB_ASSIGNMENT_GENERATION="+strconv.FormatInt(binding.AssignmentGeneration, 10),
		"BFB_CHECKOUT_ID="+binding.CheckoutId, "BFB_CORRELATION_TOKEN="+assignment.CorrelationToken,
		"BFB_ARTIFACTS_DIR="+preparation.Artifacts.Path), nil
}

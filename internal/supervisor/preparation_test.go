// ABOUTME: Verifies local preparation binding, safe artifact placement and scoped provider environment.
// ABOUTME: Exercises real directory replacement and proves private credentials and command text are not serialized.

package supervisor

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/fake"
)

func fixturePreparation(t *testing.T) (*AssignmentFiles, LocalAssignment, generated.LocalExecutionAssignment, provider.Installation, string) {
	t.Helper()
	files, wire, _, _ := fixtureAssignmentFiles(t)
	draft := LocalAssignment{IntentID: wire.TerminalIntentId, State: "intent_ready", ProviderIdentityHash: wire.ProviderIdentityHash, CorrelationToken: wire.CorrelationToken, Claim: wire.Claim}
	installation := provider.Installation{
		Executable: "/bin/sleep", IntegrationHash: provider.Hash(nil),
		ConfigFiles: []provider.ConfigSource{{Name: "user", Path: filepath.Join(t.TempDir(), "provider.json")}},
		Environment: []string{"LOCAL_CREDENTIAL=synthetic-secret-canary", "BFB_MCP_TOKEN=synthetic-authority-canary", "BFB_TASK_ID=synthetic-wrong-assignment"},
	}
	return files, draft, wire, installation, t.TempDir()
}

func TestPreparationFreezesLocalLocationsWithoutEnvironmentOrArgv(t *testing.T) {
	files, draft, wire, installation, checkout := fixturePreparation(t)
	preparation, err := files.prepare(draft, installation, provider.Hash(nil), checkout)
	if err != nil {
		t.Fatal(err)
	}
	name := draft.IntentID + ".preparation.json"
	path := filepath.Join(files.directory.file.Name(), name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"synthetic-secret-canary", "synthetic-authority-canary", "synthetic-wrong-assignment", "environment", "arguments", "argv", wire.CorrelationToken} {
		if strings.Contains(string(data), forbidden) {
			t.Fatal("private environment or invocation serialized")
		}
	}
	reader, err := ReadAssignmentFiles(filepath.Dir(files.directory.file.Name()))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	stored, err := reader.ReadPreparation(wire, checkout)
	if err != nil || !reflect.DeepEqual(preparation, stored) {
		t.Fatal("preparation read mismatch", err)
	}
	local := stored.Installation([]string{"LOCAL_CREDENTIAL=helper-local-canary", "BFB_CORRELATION_TOKEN=wrong"})
	if local.Executable != installation.Executable || local.IntegrationHash != installation.IntegrationHash || !reflect.DeepEqual(local.ConfigFiles, installation.ConfigFiles) || !reflect.DeepEqual(local.Environment, []string{"LOCAL_CREDENTIAL=helper-local-canary"}) {
		t.Fatal("helper did not reconstruct its own local installation")
	}
	again, err := files.prepare(draft, installation, provider.Hash(nil), checkout)
	if err != nil || !reflect.DeepEqual(again, preparation) {
		t.Fatal("preparation retry changed identity", err)
	}
	changed := installation
	changed.Executable = "/bin/echo"
	if _, err := files.prepare(draft, changed, provider.Hash(nil), checkout); err == nil {
		t.Fatal("later preflight replaced frozen installation")
	}
	draft.State = "offered"
	if _, err := files.prepare(draft, installation, provider.Hash(nil), checkout); err == nil {
		t.Fatal("offered intent gained new preparation authority")
	}
}

func TestPreparationEnvironmentContainsOnlyScopedBFBValues(t *testing.T) {
	files, draft, wire, installation, checkout := fixturePreparation(t)
	preparation, err := files.prepare(draft, installation, provider.Hash(nil), checkout)
	if err != nil {
		t.Fatal(err)
	}
	normal := []string{"PATH=/usr/bin:/bin", "LOCAL_CREDENTIAL=helper-local-canary", "BFB_TASK_ID=wrong", "BFB_MCP_TOKEN=forbidden", "BFB_RUN_EXECUTION_ID=wrong", "BFB_UNRECOGNIZED=forbidden"}
	environment, err := preparation.Environment(wire, normal)
	if err != nil {
		t.Fatal(err)
	}
	values := map[string]string{}
	for _, entry := range environment {
		name, value, _ := strings.Cut(entry, "=")
		if _, duplicate := values[name]; duplicate {
			t.Fatal("duplicate environment authority")
		}
		values[name] = value
	}
	expected := map[string]string{
		"PATH": "/usr/bin:/bin", "LOCAL_CREDENTIAL": "helper-local-canary",
		"BFB_WORKSPACE_ID": wire.Claim.Assignment.WorkspaceId, "BFB_PROJECT_ID": wire.Claim.Assignment.ProjectId,
		"BFB_TASK_ID": wire.Claim.Assignment.TaskId, "BFB_RUN_ID": wire.Claim.Assignment.RunId,
		"BFB_RUN_EXECUTION_ID": wire.Claim.Assignment.RunExecutionId, "BFB_ASSIGNMENT_GENERATION": "1",
		"BFB_CHECKOUT_ID": wire.Claim.Assignment.CheckoutId, "BFB_CORRELATION_TOKEN": wire.CorrelationToken,
		"BFB_ARTIFACTS_DIR": preparation.Artifacts.Path,
	}
	if !reflect.DeepEqual(values, expected) {
		t.Fatal("unexpected scoped environment")
	}
	if !outsideCheckout(preparation.Artifacts.Path, checkout) {
		t.Fatal("artifact output resolves inside checkout")
	}
	if !slices.Contains(normal, "BFB_TASK_ID=wrong") {
		t.Fatal("ambient environment was mutated")
	}
}

func TestArtifactsRejectCheckoutAncestryBeforeCreatingFiles(t *testing.T) {
	for _, alias := range []string{"direct", "symlink", "case_alias"} {
		t.Run(alias, func(t *testing.T) {
			checkout := filepath.Join(t.TempDir(), "Checkout")
			state := filepath.Join(checkout, "private-state")
			if err := os.MkdirAll(state, 0700); err != nil {
				t.Fatal(err)
			}
			root := checkout
			if alias == "symlink" {
				root = filepath.Join(t.TempDir(), "checkout-alias")
				if err := os.Symlink(checkout, root); err != nil {
					t.Fatal(err)
				}
			}
			if alias == "case_alias" {
				if runtime.GOOS != "darwin" {
					t.Skip("case-folding assertion belongs to the native macOS gate")
				}
				root = filepath.Join(filepath.Dir(checkout), "cHECKOUT")
				if _, err := os.Stat(root); err != nil {
					t.Skip("current test volume is case-sensitive")
				}
			}
			if _, err := openArtifacts(state, "01K00000000000000000000001", root, true); err == nil {
				t.Fatal("artifacts accepted inside aliased checkout")
			}
			if _, err := os.Lstat(filepath.Join(state, "run-artifacts")); !os.IsNotExist(err) {
				t.Fatal("unsafe placement created files before rejection")
			}
		})
	}
}

func TestPreparationRejectsArtifactReplacementAndNeverRepairsIt(t *testing.T) {
	for _, fault := range []string{"missing", "replaced", "symlink", "public", "parent_symlink", "parent_public", "copied_execution", "changed_claim", "changed_provider", "corrupt_record"} {
		t.Run(fault, func(t *testing.T) {
			files, draft, wire, installation, checkout := fixturePreparation(t)
			preparation, err := files.prepare(draft, installation, provider.Hash(nil), checkout)
			if err != nil {
				t.Fatal(err)
			}
			path := preparation.Artifacts.Path
			switch fault {
			case "missing":
				err = os.Remove(path)
			case "replaced":
				if err = os.Rename(path, path+"-original"); err == nil {
					err = os.Mkdir(path, 0700)
				}
			case "symlink":
				if err = os.Rename(path, path+"-original"); err == nil {
					err = os.Symlink(path+"-original", path)
				}
			case "public":
				err = os.Chmod(path, 0755)
			case "parent_symlink":
				parent := filepath.Dir(path)
				if err = os.Rename(parent, parent+"-original"); err == nil {
					err = os.Symlink(parent+"-original", parent)
				}
			case "parent_public":
				err = os.Chmod(filepath.Dir(path), 0755)
			case "copied_execution":
				wire.Claim.Assignment.RunExecutionId = daemon.NewRequestID()
				wire.Claim.Specification.RunExecutionId = wire.Claim.Assignment.RunExecutionId
			case "changed_claim":
				wire.Claim.FencingGeneration++
			case "changed_provider":
				wire.ProviderIdentityHash = provider.Hash([]byte("new provider"))
			case "corrupt_record":
				err = os.WriteFile(filepath.Join(files.directory.file.Name(), draft.IntentID+".preparation.json"), []byte("corrupt synthetic preparation"), 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := files.ReadPreparation(wire, checkout); err == nil {
				t.Fatal("changed execution preparation accepted")
			}
			if fault == "missing" || fault == "replaced" || fault == "corrupt_record" {
				if _, err := files.prepare(draft, installation, provider.Hash(nil), checkout); err == nil {
					t.Fatal("retry repaired unsafe prior preparation")
				}
			}
			if fault == "missing" {
				if _, err := os.Lstat(path); !os.IsNotExist(err) {
					t.Fatal("retry recreated missing artifacts")
				}
			}
		})
	}
}

func TestLocalPreparationRejectsUnboundedOrConfusedLocations(t *testing.T) {
	for _, fault := range []string{"relative", "traversal", "controls", "unicode", "duplicate_name", "invalid_name", "too_many", "integration"} {
		t.Run(fault, func(t *testing.T) {
			files, draft, _, installation, checkout := fixturePreparation(t)
			switch fault {
			case "relative":
				installation.Executable = "bin/provider"
			case "traversal":
				installation.Executable = "/bin/../bin/sleep"
			case "controls":
				installation.ConfigFiles[0].Path += "\n"
			case "unicode":
				installation.Executable = "/bin/\xff"
			case "duplicate_name":
				installation.ConfigFiles = append(installation.ConfigFiles, installation.ConfigFiles[0])
			case "invalid_name":
				installation.ConfigFiles[0].Name = "user;bad"
			case "too_many":
				installation.ConfigFiles = make([]provider.ConfigSource, 17)
			case "integration":
				installation.IntegrationHash = "invalid"
			}
			if _, err := files.prepare(draft, installation, provider.Hash(nil), checkout); err == nil {
				t.Fatal("invalid installation locations accepted")
			}
		})
	}
	files, draft, wire, installation, checkout := fixturePreparation(t)
	preparation, err := files.prepare(draft, installation, provider.Hash(nil), checkout)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(preparation)
	var confused map[string]any
	_ = json.Unmarshal(data, &confused)
	confused["argv"] = []string{"untrusted synthetic input"}
	if err := files.directory.write(draft.IntentID+".preparation.json", confused); err != nil {
		t.Fatal(err)
	}
	if _, err := files.ReadPreparation(wire, checkout); err == nil {
		t.Fatal("authenticated record admitted command arguments")
	}
}

func TestPreparationIndependentProbeRejectsChangedInstallation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fake-provider")
	build := exec.Command("go", "build", "-o", path, "../../cmd/bfb-fake-provider")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("synthetic provider build failed: %v\n%s", err, output)
	}
	binary, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, fault := range []string{"none", "binary_inode", "binary_canary", "symlink_target", "configuration", "integration", "manifest", "snapshot_manifest", "snapshot_version"} {
		t.Run(fault, func(t *testing.T) {
			files, draft, wire, installation, checkout := fixturePreparation(t)
			binaryPath := filepath.Join(t.TempDir(), "provider")
			if err := os.WriteFile(binaryPath, binary, 0700); err != nil {
				t.Fatal(err)
			}
			installation.Executable = binaryPath
			if fault == "symlink_target" {
				installation.Executable = binaryPath + "-alias"
				if err := os.Symlink(binaryPath, installation.Executable); err != nil {
					t.Fatal(err)
				}
			}
			configuration := installation.ConfigFiles[0].Path
			if err := os.WriteFile(configuration, []byte(`{"synthetic":"original"}`), 0600); err != nil {
				t.Fatal(err)
			}
			registry, err := provider.NewRegistry([]provider.Descriptor{fake.Descriptor()})
			if err != nil {
				t.Fatal(err)
			}
			installation.Environment = NormalEnvironment(installation.Environment)
			now := time.Now()
			probe, err := registry.Probe(context.Background(), "fake", installation, now)
			if err != nil {
				t.Fatal(err)
			}
			draft.ProviderIdentityHash, err = registry.IdentityHash(probe)
			if err != nil {
				t.Fatal(err)
			}
			draft.Claim.Snapshot.ProviderManifestId = probe.ManifestID
			draft.Claim.Specification.ConfigSnapshotHash, err = snapshotHash(draft.Claim.Snapshot)
			if err != nil {
				t.Fatal(err)
			}
			wire.Claim, wire.ProviderIdentityHash = draft.Claim, draft.ProviderIdentityHash
			preparation, err := files.Prepare(draft, registry, probe, checkout)
			if err != nil {
				t.Fatal(err)
			}
			canary := filepath.Join(filepath.Dir(binaryPath), "replacement-probed")
			switch fault {
			case "binary_inode":
				if err = os.Rename(binaryPath, binaryPath+"-original"); err == nil {
					err = os.WriteFile(binaryPath, binary, 0700)
				}
			case "binary_canary":
				if err = os.Rename(binaryPath, binaryPath+"-original"); err == nil {
					err = os.WriteFile(binaryPath, []byte("#!/bin/sh\n: > '"+canary+"'\nexit 1\n"), 0700)
				}
			case "symlink_target":
				if err = os.WriteFile(binaryPath+"-other", binary, 0700); err == nil {
					err = os.Remove(installation.Executable)
				}
				if err == nil {
					err = os.Symlink(binaryPath+"-other", installation.Executable)
				}
			case "configuration":
				err = os.WriteFile(configuration, []byte(`{"synthetic":"changed"}`), 0600)
			case "integration":
				preparation.Provider.IntegrationHash = provider.Hash([]byte("different integration"))
			case "manifest":
				descriptor := fake.Descriptor()
				descriptor.Manifest.Version = "1.0.1"
				registry, err = provider.NewRegistry([]provider.Descriptor{descriptor})
			case "snapshot_manifest", "snapshot_version":
				if fault == "snapshot_manifest" {
					wire.Claim.Snapshot.ProviderManifestId = provider.Hash([]byte("wrong manifest"))
				} else {
					wire.Claim.Snapshot.ProviderVersion = "9.0.0"
				}
				wire.Claim.Specification.ConfigSnapshotHash, err = snapshotHash(wire.Claim.Snapshot)
				preparation.ClaimHash = claimIdentity(wire.Claim)
			}
			if err != nil {
				t.Fatal(err)
			}
			_, err = preparation.Probe(context.Background(), registry, wire, []string{"LOCAL_CREDENTIAL=helper-own-credential"}, now.Add(time.Second))
			if fault == "none" && err != nil {
				t.Fatal("independent helper probe rejected unchanged provider", err)
			}
			if fault != "none" && err == nil {
				t.Fatal("fresh helper probe accepted changed installation")
			}
			if fault == "binary_canary" {
				if _, err := os.Lstat(canary); !os.IsNotExist(err) {
					t.Fatal("replacement binary executed during preflight")
				}
			}
		})
	}
}

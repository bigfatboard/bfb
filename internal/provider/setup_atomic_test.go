// ABOUTME: Reproduces non-cooperating configuration edits in the final publication and rollback windows.
// ABOUTME: Certifies atomic displaced-file retention and recovery at each staged publication boundary.

package provider

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/qdis/bfb/internal/daemon"
)

func atomicDirectory(t *testing.T) *configDirectory {
	t.Helper()
	directory, err := openConfigDirectory(filepath.Join(t.TempDir(), "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = directory.root.Close() })
	return directory
}

func assertAtomicConflict(t *testing.T, err error) {
	t.Helper()
	if err == nil || daemon.AsFailure(err).Code != "provider_setup_conflict" {
		t.Fatalf("expected conflict, got %v", err)
	}
}

func TestSetupAtomicPublicationRetainsRacedEdit(t *testing.T) {
	directory := atomicDirectory(t)
	if err := directory.root.WriteFile(directory.name, []byte("external edit after final check"), 0644); err != nil {
		t.Fatal(err)
	}
	err := directory.replace([]byte("approved replacement"), 0600, configHash([]byte("expected original"), true), true)
	assertAtomicConflict(t, err)
	displaced, present, mode, err := directory.read(directory.stagedName())
	if err != nil || !present || string(displaced) != "external edit after final check" || mode != 0600 {
		t.Fatal("raced bytes were lost or exposed", err)
	}
	if err := directory.restoreAbsence(configHash([]byte("approved replacement"), true)); err == nil {
		t.Fatal("pending displacement was overwritten")
	}
}

func TestSetupMissingTargetPublicationNeverReplacesRacedFile(t *testing.T) {
	directory := atomicDirectory(t)
	if err := directory.root.WriteFile(directory.name, []byte("external new file"), 0600); err != nil {
		t.Fatal(err)
	}
	err := directory.replace([]byte("approved replacement"), 0600, configHash(nil, false), false)
	assertAtomicConflict(t, err)
	current, _, _, err := directory.read(directory.name)
	if err != nil || string(current) != "external new file" {
		t.Fatal("new file overwritten", err)
	}
}

func TestSetupMissingTargetRollbackRetainsRacedFile(t *testing.T) {
	directory := atomicDirectory(t)
	if err := directory.root.WriteFile(directory.name, []byte("external edit during rollback"), 0644); err != nil {
		t.Fatal(err)
	}
	assertAtomicConflict(t, directory.restoreAbsence(configHash([]byte("approved replacement"), true)))
	displaced, present, mode, err := directory.read(directory.stagedName())
	if err != nil || !present || string(displaced) != "external edit during rollback" || mode != 0600 {
		t.Fatal("rollback erased raced edit", err)
	}
}

func TestSetupRecoveryPublicationBoundaries(t *testing.T) {
	for _, phase := range []string{"journal_only", "before_exchange", "after_exchange", "after_rollback_exchange", "raced_displacement", "partial_journal"} {
		t.Run(phase, func(t *testing.T) {
			directory := atomicDirectory(t)
			before, after := []byte("original exact bytes"), []byte("approved bytes")
			record := recoveryRecord{Version: 1, Target: directory.name, Before: before, BeforeHash: configHash(before, true), AfterHash: configHash(after, true), Present: true, Mode: 0600}
			raw, _ := json.Marshal(record)
			if phase == "partial_journal" {
				raw = raw[:len(raw)/2]
			}
			_, recovery := directory.names()
			if err := directory.writeExclusive(recovery, raw, 0600); err != nil {
				t.Fatal(err)
			}
			current, stage := before, []byte(nil)
			switch phase {
			case "before_exchange":
				stage = after
			case "after_exchange":
				current, stage = after, before
			case "after_rollback_exchange":
				current, stage = before, after
			case "raced_displacement":
				current, stage = after, []byte("external edit")
			}
			if err := directory.root.WriteFile(directory.name, current, 0600); err != nil {
				t.Fatal(err)
			}
			if stage != nil {
				if err := directory.writeExclusive(directory.stagedName(), stage, 0600); err != nil {
					t.Fatal(err)
				}
			}
			err := directory.recover()
			if phase == "raced_displacement" || phase == "partial_journal" {
				assertAtomicConflict(t, err)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got, present, _, err := directory.read(directory.name)
			if err != nil || !present || string(got) != string(before) {
				t.Fatal("recovery lost exact original bytes", err)
			}
			if _, present, _, err := directory.read(recovery); err != nil || present {
				t.Fatal("recovery journal retained after success")
			}
		})
	}
}

func TestSetupContextCancellationCannotPublish(t *testing.T) {
	// The full editor contract is exercised externally; a forged internal proposal still
	// cannot cross approval and cancellation checks to become a filesystem mutation.
	directory := atomicDirectory(t)
	if err := directory.root.WriteFile(directory.name, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	proposal := SetupProposal{ID: "synthetic", ExpectedHash: configHash([]byte("{}"), true), path: filepath.Join(directory.directory, directory.name), directory: directory.directory, parentIdentity: directory.identity, before: []byte("{}"), after: []byte("changed"), present: true, mode: 0600}
	proposal.seal = setupSeal(proposal)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := ApplySetup(ctx, proposal, SetupApproval{Approved: true, ProposalID: proposal.ID, ExpectedHash: proposal.ExpectedHash}, func(context.Context) error { return nil })
	if err == nil || daemon.AsFailure(err).Code != "provider_setup_failed" {
		t.Fatal(err)
	}
	current, _ := os.ReadFile(proposal.path)
	if string(current) != "{}" {
		t.Fatal("cancelled setup wrote configuration")
	}
}

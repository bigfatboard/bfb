// ABOUTME: Exercises immutable provider-image inputs and process replacement races without provider output inference.
// ABOUTME: Uses bounded synthetic observations around actual executable and configuration fingerprints.

package supervisor

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/fake"
)

func imageFixtureBinary(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "provider")
	if output, err := exec.Command("go", "build", "-o", binary, "../../cmd/bfb-fake-provider").CombinedOutput(); err != nil {
		t.Fatalf("fake provider build: %v %s", err, output)
	}
	return binary
}

func imageFixture(t *testing.T, binary string) LaunchPreparation {
	t.Helper()
	copy := filepath.Join(t.TempDir(), "provider")
	data, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(copy, data, 0700); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(t.TempDir(), "provider.json")
	if err := os.WriteFile(config, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	installation := provider.Installation{Executable: copy, ConfigFiles: []provider.ConfigSource{{Name: "user", Path: config}}, IntegrationHash: provider.Hash(nil)}
	registry, err := provider.NewRegistry([]provider.Descriptor{fake.Descriptor()})
	if err != nil {
		t.Fatal(err)
	}
	probe, err := registry.Probe(context.Background(), "fake", installation, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	_, source, err := registry.InstallationSource(probe)
	if err != nil {
		t.Fatal(err)
	}
	locations, err := installationLocations(installation)
	if err != nil {
		t.Fatal(err)
	}
	return LaunchPreparation{SourceHash: source, Provider: locations}
}

func TestImageRejectsProcessAndSourceRaces(t *testing.T) {
	binary := imageFixtureBinary(t)
	for _, fault := range []string{"unchanged", "before_absent", "before_reuse", "after_reuse", "after_zombie", "after_parent", "after_group", "kernel_error", "wrong_image", "second_image", "native_error", "binary_swap", "config_swap", "unbound_source"} {
		t.Run(fault, func(t *testing.T) {
			preparation := imageFixture(t, binary)
			stamp, err := provider.FingerprintExecutable(preparation.Provider.Executable)
			if err != nil {
				t.Fatal(err)
			}
			process := fixtureProcess(12345, 12344, 12345)
			calls, images := 0, 0
			processes := func() (ProcessTable, error) {
				calls++
				current := process
				if fault == "before_absent" && calls == 1 {
					return ProcessTable{}, nil
				}
				if fault == "before_reuse" && calls == 1 || fault == "after_reuse" && calls == 2 {
					current.StartIdentity = "1001:42"
				}
				if fault == "after_zombie" && calls == 2 {
					current.Zombie = true
				}
				if fault == "after_parent" && calls == 2 {
					current.ParentPID = 1
				}
				if fault == "after_group" && calls == 2 {
					current.GroupID++
				}
				if fault == "kernel_error" {
					return nil, failure("containment_unknown")
				}
				return ProcessTable{process.PID: current}, nil
			}
			executable := func(pid int) (string, error) {
				if pid != process.PID {
					t.Fatal("image observer chose another process")
				}
				images++
				if fault == "wrong_image" || fault == "second_image" && images == 2 {
					return "/synthetic/waiting-helper", nil
				}
				if fault == "native_error" {
					return "", failure("provider_unavailable")
				}
				if images == 1 && fault == "binary_swap" {
					if err := os.Rename(preparation.Provider.Executable, preparation.Provider.Executable+".old"); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(preparation.Provider.Executable, []byte("#!/bin/sh\nexit 1\n"), 0700); err != nil {
						t.Fatal(err)
					}
				}
				if images == 1 && fault == "config_swap" {
					if err := os.WriteFile(preparation.Provider.Configuration[0].Path, []byte("changed"), 0600); err != nil {
						t.Fatal(err)
					}
				}
				return stamp.CanonicalPath, nil
			}
			if fault == "unbound_source" {
				preparation.SourceHash = provider.Hash(nil)
			}
			err = inspectImage(process, preparation, processes, executable)
			if (fault == "unchanged") != (err == nil) {
				t.Fatal("provider image disposition", err)
			}
			if fault == "unchanged" && (calls != 2 || images != 2) {
				t.Fatal("image check omitted native revalidation")
			}
			if fault == "unbound_source" && images != 0 {
				t.Fatal("unbound preparation reached native identity inspection")
			}
		})
	}
}

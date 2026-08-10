// ABOUTME: Proves the foundation's Go executable can be built and started.
// ABOUTME: Keeps the process smoke test independent of future daemon behavior.

package main

import (
	"os/exec"
	"path/filepath"
	"testing"
)

func TestBinaryStartsAndExits(t *testing.T) {
	binaryPath := filepath.Join(t.TempDir(), "bfb")
	build := exec.Command("go", "build", "-o", binaryPath, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build bfb: %v\n%s", err, output)
	}

	run := exec.Command(binaryPath)
	if output, err := run.CombinedOutput(); err != nil {
		t.Fatalf("run bfb: %v\n%s", err, output)
	}
}

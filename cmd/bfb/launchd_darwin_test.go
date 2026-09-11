// ABOUTME: Verifies installation and health of a real per-user launchd job with empty BFB state.
// ABOUTME: Uses a unique temporary service and removes only that service and its own plist afterward.

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
)

func TestLaunchdCleanBFBInstall(t *testing.T) {
	binary, paths := processFixture(t)
	agentsDirectory, err := daemon.DefaultAgentsDirectory()
	if err != nil {
		t.Fatal(err)
	}
	label := "com.tenira.bfb.test." + strings.ToLower(daemon.NewRequestID())
	target := fmt.Sprintf("gui/%d/%s", os.Getuid(), label)
	plist := filepath.Join(agentsDirectory, label+".plist")
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = exec.CommandContext(ctx, "/bin/launchctl", "bootout", target).Run()
		_ = os.Remove(plist)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err = daemon.Install(ctx, paths, binary, agentsDirectory, label); err != nil {
		t.Fatal(err)
	}
	awaitDaemon(t, binary, paths)
	if err = daemon.ValidateFileMode(plist); err != nil {
		t.Fatal(err)
	}
	if err = daemon.Install(ctx, paths, binary, agentsDirectory, label); err != nil {
		t.Fatal("idempotent install", err)
	}
	other, err := daemon.StatePaths(filepath.Join(filepath.Dir(binary), "other"))
	if err != nil {
		t.Fatal(err)
	}
	if err = daemon.Install(ctx, other, binary, agentsDirectory, label); err == nil || daemon.AsFailure(err).Code != "install_conflict" {
		t.Fatalf("conflicting install: %v", err)
	}
	awaitDaemon(t, binary, paths)
}

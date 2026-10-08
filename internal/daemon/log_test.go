// ABOUTME: Proves bounded rotation and strict secret-safe diagnostic serialization.
// ABOUTME: Rejects seeded private content and sanitizes tampered local log entries.

package daemon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLogRedactionAndRotation(t *testing.T) {
	p := testPaths(t)
	logger := NewLogger(p)
	logger.max = 512
	canaries := []string{"Bearer synthetic-secret", "/Users/synthetic/project", "private task body", "hook payload", "TOKEN=synthetic-secret"}
	for _, value := range canaries {
		for _, event := range []LogEvent{{Event: value}, {Event: "rpc_failed", Code: value}, {Event: "rpc_failed", RequestID: value}} {
			if err := logger.Record(event); err == nil {
				t.Fatal("accepted private log field")
			}
		}
	}
	for index := 0; index < 100; index++ {
		if err := logger.Record(LogEvent{Event: "rpc_failed", Code: "invalid_request", RequestID: NewRequestID()}); err != nil {
			t.Fatal(err)
		}
	}
	files, err := os.ReadDir(p.Logs)
	if err != nil || len(files) != 4 {
		t.Fatalf("rotation %d: %v", len(files), err)
	}
	for _, file := range files {
		info, _ := file.Info()
		if info.Size() > 512 || !privateOwner(info) {
			t.Fatalf("unsafe rotation: %s", file.Name())
		}
		data, _ := os.ReadFile(filepath.Join(p.Logs, file.Name()))
		for _, canary := range canaries {
			if strings.Contains(string(data), canary) {
				t.Fatal("canary leaked")
			}
		}
	}
	entries, err := logger.Read(1)
	if err != nil || len(entries) != 1 {
		t.Fatalf("bounded read: %v", err)
	}
	if _, err = logger.Read(201); err == nil {
		t.Fatal("accepted unbounded log read")
	}
}

func TestLogReaderDropsUnknownAndUnsafeFields(t *testing.T) {
	p := testPaths(t)
	logger := NewLogger(p)
	data := `{"at":"2026-09-11T00:00:00Z","event":"daemon_started","secret":"synthetic-token"}` + "\n" + `{"at":"2026-09-11T00:00:00Z","event":"synthetic-private-body"}` + "\n"
	if err := os.WriteFile(logger.path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	entries, err := logger.Read(10)
	if err != nil || len(entries) != 1 {
		t.Fatalf("sanitized log: %v", err)
	}
	encoded, _ := json.Marshal(entries)
	if strings.Contains(string(encoded), "synthetic") {
		t.Fatal("tampered content leaked")
	}
}

func TestLogSymlinkIsNeverFollowed(t *testing.T) {
	p := testPaths(t)
	logger := NewLogger(p)
	target := filepath.Join(p.Root, "untouched")
	if err := os.WriteFile(target, []byte("synthetic-canary"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, logger.path); err != nil {
		t.Fatal(err)
	}
	if err := logger.Record(LogEvent{Event: "daemon_started"}); err == nil {
		t.Fatal("wrote symlink log")
	}
	if _, err := logger.Read(100); err == nil {
		t.Fatal("read symlink log")
	}
	data, _ := os.ReadFile(target)
	if string(data) != "synthetic-canary" {
		t.Fatal("changed target")
	}
}

func TestLogReaderRejectsSymlinkedStateRoot(t *testing.T) {
	p := testPaths(t)
	logger := NewLogger(p)
	if err := logger.Record(LogEvent{Event: "daemon_started"}); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(p.Cache, "state-alias")
	if err := os.Symlink(p.Root, alias); err != nil {
		t.Fatal(err)
	}
	aliased, err := StatePaths(alias)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = NewLogger(aliased).Read(100); err == nil {
		t.Fatal("read through symlinked state root")
	}
}

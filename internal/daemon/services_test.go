// ABOUTME: Checks background service lifetime against the daemon's socket and database ownership.
// ABOUTME: Requires joined service shutdown before storage closes and failed startup to release ownership.

package daemon

import (
	"context"
	"errors"
	"os"
	"testing"
)

func TestServiceOwnsDatabaseUntilJoinedShutdown(t *testing.T) {
	directory, err := os.MkdirTemp("", "bfb-service-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(directory)
	paths, err := StatePaths(directory)
	if err != nil {
		t.Fatal(err)
	}
	registry := NewRegistry()
	stopped := make(chan struct{})
	var store *Store
	err = registry.RegisterService("synthetic.background", func(ctx context.Context, active *Store) (func(), error) {
		store = active
		go func() { <-ctx.Done(); close(stopped) }()
		return func() {
			<-stopped
			if err := store.DB.Ping(); err != nil {
				t.Error("database closed before joining service", err)
			}
		}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	server, err := Start(context.Background(), paths, registry)
	if err != nil {
		t.Fatal(err)
	}
	server.Close()
	if err := store.DB.Ping(); err == nil {
		t.Fatal("database survived daemon shutdown")
	}
}

func TestFailedServiceStartupReleasesDaemon(t *testing.T) {
	directory, err := os.MkdirTemp("", "bfb-service-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(directory)
	paths, err := StatePaths(directory)
	if err != nil {
		t.Fatal(err)
	}
	registry := NewRegistry()
	if err := registry.RegisterService("synthetic.failure", func(context.Context, *Store) (func(), error) { return nil, errors.New("synthetic startup failure") }); err != nil {
		t.Fatal(err)
	}
	if _, err := Start(context.Background(), paths, registry); err == nil {
		t.Fatal("service failure ignored")
	}
	server, err := Start(context.Background(), paths, nil)
	if err != nil {
		t.Fatal("failed service retained socket or lock", err)
	}
	server.Close()
}

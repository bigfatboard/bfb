// ABOUTME: Proves that a supervised helper can read live WAL state without altering daemon recovery.
// ABOUTME: Rejects missing, older, newer and tampered schemas while preserving their original contents.

package daemon

import (
	"context"
	"os"
	"testing"
)

func TestReaderPreservesLiveStateAndCannotWrite(t *testing.T) {
	paths := testPaths(t)
	store := openTestStore(t, paths)
	defer store.Close()
	if _, err := store.DB.Exec("INSERT INTO process_observations VALUES ('live-helper', 123, 'synthetic-start', 'attached')"); err != nil {
		t.Fatal(err)
	}
	reader, err := OpenReader(context.Background(), paths)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	var state string
	if err = reader.QueryRow("SELECT state FROM process_observations WHERE id = 'live-helper'").Scan(&state); err != nil || state != "attached" {
		t.Fatal("helper changed or failed to read live state", err)
	}
	if _, err = reader.Exec("UPDATE process_observations SET state = 'ended'"); err == nil {
		t.Fatal("read-only helper modified daemon state")
	}
	if _, err = reader.Exec("PRAGMA query_only=0"); err != nil {
		t.Fatal(err)
	}
	if _, err = reader.Exec("UPDATE process_observations SET state = 'ended'"); err == nil {
		t.Fatal("disabling query_only bypassed read-only file access")
	}
	if _, err = store.DB.Exec("UPDATE process_observations SET state = 'ended' WHERE id = 'live-helper'"); err != nil {
		t.Fatal(err)
	}
	if err = reader.QueryRow("SELECT state FROM process_observations WHERE id = 'live-helper'").Scan(&state); err != nil || state != "ended" {
		t.Fatal("reader ignored a new WAL commit", err)
	}
}

func TestReaderCannotCreateOrMigrateState(t *testing.T) {
	for _, fault := range []string{"missing", "older", "newer", "checksum"} {
		t.Run(fault, func(t *testing.T) {
			paths := testPaths(t)
			if fault != "missing" {
				migrations := kernelMigrations()
				if fault == "older" {
					migrations = migrations[:len(migrations)-1]
				}
				store, err := openStore(context.Background(), paths, migrations, nil)
				if err != nil {
					t.Fatal(err)
				}
				if fault == "newer" {
					_, err = store.DB.Exec("INSERT INTO schema_migrations VALUES (?, 'future.sql', 'future')", StorageVersion+1)
				}
				if fault == "checksum" {
					_, err = store.DB.Exec("UPDATE schema_migrations SET sha256 = 'changed' WHERE version = 1")
				}
				_ = store.Close()
				if err != nil {
					t.Fatal(err)
				}
			}
			before, _ := os.ReadFile(paths.Database)
			if reader, err := OpenReader(context.Background(), paths); err == nil {
				_ = reader.Close()
				t.Fatal("unsafe schema opened")
			}
			after, _ := os.ReadFile(paths.Database)
			if string(before) != string(after) {
				t.Fatal("read-only opening modified the database")
			}
			if fault == "missing" {
				if _, err := os.Lstat(paths.Database); !os.IsNotExist(err) {
					t.Fatal("reader created a database")
				}
			}
		})
	}
}

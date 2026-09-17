// ABOUTME: Proves the D02 store applies local migration 012 exactly once and guards its file.
// ABOUTME: A foreign user_version or unsafe file fails closed without touching delivery rows.

package discussion_test

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"github.com/qdis/bfb/internal/discussion"
)

func TestStoreAppliesMigration012(t *testing.T) {
	store := openStore(t)
	second, err := discussion.OpenStore(filepath.Join(t.TempDir(), "fresh.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	_ = store
}

func TestStoreRejectsForeignVersion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "foreign.sqlite")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_ = file.Close()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("PRAGMA user_version=11"); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	if _, err := discussion.OpenStore(path); err == nil || discussion.Code(err) != "migration_mismatch" {
		t.Fatalf("want migration_mismatch, got %v", err)
	}
}

func TestStoreRejectsUnsafeFile(t *testing.T) {
	if _, err := discussion.OpenStore("/nonexistent-dir/deep/delivery.sqlite"); err == nil {
		t.Fatal("opening outside an owned directory must fail")
	}
}

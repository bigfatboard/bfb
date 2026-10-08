// ABOUTME: Opens the D02 delivery store and applies local migration 012 exactly once.
// ABOUTME: Shares no table with hook, inbox, or pending-operation state; one file holds one package.

package discussion

import (
	"database/sql"
	_ "embed"
	"os"
	"syscall"

	_ "modernc.org/sqlite"
)

//go:embed migrations/012_discussion_delivery.sql
var deliveryMigration string

// StorageVersion is the local migration number this package owns.
const StorageVersion = 12

// Store is the durable D02 delivery state. Writers must serialize through
// one handle per process; the daemon opens it with MaxOpenConns(1).
type Store struct{ db *sql.DB }

// OpenStore opens (creating when absent) the delivery database at path and
// applies local migration 012. It never touches any other package's state.
func OpenStore(path string) (*Store, error) {
	info, err := os.Stat(path)
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, failure("storage_failed")
		}
	} else {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != uint32(os.Getuid()) || info.Mode().Perm()&0077 != 0 {
			return nil, failure("unsafe_state")
		}
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, failure("storage_failed")
	}
	_ = file.Close()
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=synchronous(FULL)")
	if err != nil {
		return nil, failure("storage_failed")
	}
	db.SetMaxOpenConns(1)
	failed := true
	defer func() {
		if failed {
			_ = db.Close()
		}
	}()
	var check string
	if err = db.QueryRow("PRAGMA quick_check").Scan(&check); err != nil || check != "ok" {
		return nil, failure("storage_failed")
	}
	if err = db.QueryRow("PRAGMA journal_mode=WAL").Scan(&check); err != nil || check != "wal" {
		return nil, failure("storage_failed")
	}
	if _, err = db.Exec(deliveryMigration); err != nil {
		return nil, failure("storage_failed")
	}
	var version int
	if err = db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return nil, failure("storage_failed")
	}
	if version != 0 && version != StorageVersion {
		return nil, failure("migration_mismatch")
	}
	if _, err = db.Exec("PRAGMA user_version=12"); err != nil {
		return nil, failure("storage_failed")
	}
	failed = false
	return &Store{db: db}, nil
}

// Close releases the delivery database.
func (store *Store) Close() error { return store.db.Close() }

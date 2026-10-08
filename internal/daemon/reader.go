// ABOUTME: Opens existing daemon state for supervised helpers without migrations or recovery writes.
// ABOUTME: Verifies private files and the exact schema before granting read-only checkout access.

package daemon

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"fmt"
	"net/url"
	"os"

	"golang.org/x/sys/unix"
)

// OpenReader must follow authenticated daemon registration. It deliberately
// does not use OpenStore: observing a checkout must not reset live process state.
// SQLite mode=ro retains WAL change detection; immutable/nolock are inappropriate.
func OpenReader(ctx context.Context, paths Paths) (*sql.DB, error) {
	root, err := os.Lstat(paths.Root)
	if err != nil || !root.IsDir() || !privateOwner(root) {
		return nil, &Failure{Code: "unsafe_state"}
	}
	for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
		if err = checkOptionalFile(paths.Database + suffix); err != nil {
			return nil, err
		}
	}
	file, err := privateFile(paths.Database, unix.O_RDONLY)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	identity, err := file.Stat()
	if err != nil {
		return nil, &Failure{Code: "unsafe_state"}
	}
	dsn := (&url.URL{Scheme: "file", Path: paths.Database}).String() + "?mode=ro&_pragma=busy_timeout(1000)&_pragma=query_only(1)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, &Failure{Code: "storage_failed"}
	}
	db.SetMaxOpenConns(1)
	failed := true
	defer func() {
		if failed {
			_ = db.Close()
		}
	}()
	var appID, queryOnly int
	if db.QueryRowContext(ctx, "PRAGMA application_id").Scan(&appID) != nil || appID != applicationID || db.QueryRowContext(ctx, "PRAGMA query_only").Scan(&queryOnly) != nil || queryOnly != 1 {
		return nil, &Failure{Code: "storage_failed"}
	}
	rows, err := db.QueryContext(ctx, "SELECT version, name, sha256 FROM schema_migrations ORDER BY version")
	if err != nil {
		return nil, &Failure{Code: "migration_mismatch"}
	}
	defer rows.Close()
	migrations := kernelMigrations()
	applied := 0
	for rows.Next() {
		var version int
		var name, digest string
		if rows.Scan(&version, &name, &digest) != nil || version != applied+1 || version > len(migrations) || name != migrations[version-1].name || digest != fmt.Sprintf("%x", sha256.Sum256([]byte(migrations[version-1].sql))) {
			return nil, &Failure{Code: "migration_mismatch"}
		}
		applied++
	}
	if rows.Err() != nil || applied != len(migrations) {
		return nil, &Failure{Code: "migration_mismatch"}
	}
	current, err := os.Lstat(paths.Database)
	if err != nil || !os.SameFile(identity, current) {
		return nil, &Failure{Code: "unsafe_state"}
	}
	failed = false
	return db, nil
}

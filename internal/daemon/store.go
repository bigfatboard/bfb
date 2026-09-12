// ABOUTME: Opens the daemon SQLite WAL database and applies checksum-verified atomic migrations.
// ABOUTME: Preserves corrupt or incompatible data and marks unreconciled processes unknown on restart.

package daemon

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"embed"
	"fmt"
	"net/url"
	"sort"
	"strings"

	"golang.org/x/sys/unix"
	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

const StorageVersion = 4
const applicationID = 0x424642

type Store struct {
	DB    *sql.DB
	Paths Paths
}

type migration struct {
	name, sql string
}

func kernelMigrations() []migration {
	names, _ := migrationFiles.ReadDir("migrations")
	result := make([]migration, 0, len(names))
	for _, entry := range names {
		data, _ := migrationFiles.ReadFile("migrations/" + entry.Name())
		result = append(result, migration{name: entry.Name(), sql: string(data)})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].name < result[j].name })
	return result
}

func OpenStore(ctx context.Context, paths Paths) (*Store, error) {
	return openStore(ctx, paths, kernelMigrations(), nil)
}

func openStore(ctx context.Context, paths Paths, migrations []migration, beforeCommit func(int) error) (*Store, error) {
	for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
		if err := checkOptionalFile(paths.Database + suffix); err != nil {
			return nil, err
		}
	}
	f, err := privateFile(paths.Database, unix.O_CREAT|unix.O_RDWR)
	if err != nil {
		return nil, err
	}
	_ = f.Close()
	dsn := (&url.URL{Scheme: "file", Path: paths.Database}).String() + "?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=synchronous(FULL)"
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
	var check string
	if err = db.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&check); err != nil || check != "ok" {
		return nil, &Failure{Code: "storage_failed"}
	}
	var appID, tables int
	if err = db.QueryRowContext(ctx, "PRAGMA application_id").Scan(&appID); err != nil {
		return nil, &Failure{Code: "storage_failed"}
	}
	if err = db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").Scan(&tables); err != nil || (appID != applicationID && (appID != 0 || tables != 0)) {
		return nil, &Failure{Code: "storage_failed"}
	}
	if err = db.QueryRowContext(ctx, "PRAGMA journal_mode=WAL").Scan(&check); err != nil || check != "wal" {
		return nil, &Failure{Code: "storage_failed"}
	}
	if err = applyMigrations(ctx, db, migrations, beforeCommit); err != nil {
		return nil, err
	}
	if _, err = db.ExecContext(ctx, "UPDATE process_observations SET state = 'unknown' WHERE state = 'attached'"); err != nil {
		return nil, &Failure{Code: "storage_failed"}
	}
	failed = false
	return &Store{DB: db, Paths: paths}, nil
}

func applyMigrations(ctx context.Context, db *sql.DB, migrations []migration, beforeCommit func(int) error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return &Failure{Code: "storage_failed"}
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL) STRICT"); err != nil {
		return &Failure{Code: "storage_failed"}
	}
	rows, err := tx.QueryContext(ctx, "SELECT version, name, sha256 FROM schema_migrations ORDER BY version")
	if err != nil {
		return &Failure{Code: "storage_failed"}
	}
	applied := 0
	for rows.Next() {
		var version int
		var name, digest string
		if err = rows.Scan(&version, &name, &digest); err != nil || version != applied+1 || version > len(migrations) || name != migrations[version-1].name || digest != fmt.Sprintf("%x", sha256.Sum256([]byte(migrations[version-1].sql))) {
			_ = rows.Close()
			return &Failure{Code: "migration_mismatch"}
		}
		applied++
	}
	if err = rows.Err(); err != nil {
		_ = rows.Close()
		return &Failure{Code: "storage_failed"}
	}
	_ = rows.Close()
	for index := applied; index < len(migrations); index++ {
		item := migrations[index]
		if !strings.HasPrefix(item.name, fmt.Sprintf("%03d_", index+1)) {
			return &Failure{Code: "migration_mismatch"}
		}
		if _, err = tx.ExecContext(ctx, item.sql); err != nil {
			return &Failure{Code: "storage_failed"}
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO schema_migrations (version, name, sha256) VALUES (?, ?, ?)", index+1, item.name, fmt.Sprintf("%x", sha256.Sum256([]byte(item.sql)))); err != nil {
			return &Failure{Code: "storage_failed"}
		}
		if beforeCommit != nil {
			if err = beforeCommit(index + 1); err != nil {
				return &Failure{Code: "storage_failed"}
			}
		}
	}
	if _, err = tx.ExecContext(ctx, fmt.Sprintf("PRAGMA application_id=%d", applicationID)); err != nil {
		return &Failure{Code: "storage_failed"}
	}
	if err = tx.Commit(); err != nil {
		return &Failure{Code: "storage_failed"}
	}
	return nil
}

func (s *Store) RecoveryPending(ctx context.Context) (int, error) {
	var count int
	err := s.DB.QueryRowContext(ctx, "SELECT count(*) FROM process_observations WHERE state = 'unknown'").Scan(&count)
	if err != nil {
		return 0, &Failure{Code: "storage_failed"}
	}
	return count, nil
}

func (s *Store) Close() error { return s.DB.Close() }

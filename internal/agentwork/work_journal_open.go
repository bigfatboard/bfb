// ABOUTME: Exclusively owns the independent agent journal and binds it to a durable private identity.
// ABOUTME: Rejects unsafe files and ambiguous missing state without claiming rollback resistance.

package agentwork

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
	_ "modernc.org/sqlite"
)

var errWorkStorage = errors.New("agent work storage failed")
var errWorkUnsafe = errors.New("agent work state unsafe")
var errWorkIdentity = errors.New("agent work history identity unavailable")
var errWorkMigration = errors.New("agent work journal schema unrecognized")
var errWorkAlreadyOwned = errors.New("agent work journal already owned")

const workIdentityPrefix = "BFB-AGENT-WORK-JOURNAL-V1\n"

type workJournal struct {
	db          *sql.DB
	lock        *os.File
	incarnation string
	clock       captureClock
	mu          sync.Mutex
	last        time.Duration
	hasSample   bool
	clockError  error
}

// The daemon opens this before serving business writes and retains it until all
// handlers/services join. The sentinel detects accidental replacement, not
// rollback or deletion of both files by the same user. No missing history is
// reconstructed from a capture signature.
func openWorkJournal(ctx context.Context, path string, clock captureClock) (*workJournal, error) {
	return openWorkJournalWithHook(ctx, path, clock, nil)
}

func openWorkJournalWithHook(ctx context.Context, path string, clock captureClock, beforeCommit func() error) (*workJournal, error) {
	if !filepath.IsAbs(path) || clock == nil {
		return nil, errWorkUnsafe
	}
	info, err := os.Lstat(filepath.Dir(path))
	if err != nil || !info.IsDir() || !workPrivateOwner(info) {
		return nil, errWorkUnsafe
	}
	lock, err := workPrivateFile(path+".lock", unix.O_CREAT|unix.O_RDWR)
	if err != nil {
		return nil, err
	}
	if err = unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = lock.Close()
		return nil, errWorkAlreadyOwned
	}
	journal := &workJournal{lock: lock, clock: clock}
	failed := true
	defer func() {
		if failed {
			_ = journal.close()
		}
	}()
	for _, suffix := range []string{"", "-wal", "-shm", "-journal", ".identity"} {
		if _, err = workOptionalFile(path + suffix); err != nil {
			return nil, err
		}
	}
	databaseExists, _ := workOptionalFile(path)
	identityExists, _ := workOptionalFile(path + ".identity")
	if identityExists && !databaseExists {
		return nil, errWorkIdentity
	}
	var identity string
	if identityExists {
		identity, err = readWorkIdentity(path + ".identity")
		if err != nil {
			return nil, err
		}
	}
	if !databaseExists {
		identity, err = workRandomIdentity()
		if err != nil || writeWorkIdentity(path+".identity", identity) != nil {
			return nil, errWorkStorage
		}
		file, err := workPrivateFile(path, unix.O_CREAT|unix.O_EXCL|unix.O_RDWR)
		if err != nil {
			return nil, err
		}
		if err = file.Sync(); err != nil {
			_ = file.Close()
			return nil, errWorkStorage
		}
		if err = file.Close(); err != nil || syncWorkDirectory(path) != nil {
			return nil, errWorkStorage
		}
	}
	dsn := (&url.URL{Scheme: "file", Path: path}).String() + "?mode=rw&_txlock=immediate&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=synchronous(FULL)"
	journal.db, err = sql.Open("sqlite", dsn)
	if err != nil {
		return nil, errWorkStorage
	}
	journal.db.SetMaxOpenConns(1)
	var check string
	if err = journal.db.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&check); err != nil || check != "ok" {
		return nil, errWorkStorage
	}
	version, err := inspectWorkSchema(ctx, journal.db)
	if err != nil {
		return nil, err
	}
	if databaseExists && version == 0 {
		var legacy int
		if journal.db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE name='pending_operations' AND type='table'").Scan(&legacy) != nil {
			return nil, errWorkStorage
		}
		// An existing empty file has no recognized historical head and may be
		// half-creation or lost state. Fresh creation is only absent/absent.
		if legacy == 0 {
			return nil, errWorkIdentity
		}
	}
	if version == workJournalVersion {
		if !identityExists {
			return nil, errWorkIdentity
		}
		if err = verifyWorkIdentity(ctx, journal.db, identity); err != nil {
			return nil, err
		}
	} else {
		// A sentinel paired with an old schema can be an interrupted adoption.
		// Preserve both and require explicit recovery instead of guessing.
		if databaseExists && identityExists {
			return nil, errWorkIdentity
		}
		if databaseExists {
			identity, err = workRandomIdentity()
			if err != nil || writeWorkIdentity(path+".identity", identity) != nil {
				return nil, errWorkStorage
			}
		}
		if err = migrateWorkJournal(ctx, journal.db, identity, beforeCommit); err != nil {
			return nil, err
		}
		if syncWorkDirectory(path) != nil {
			return nil, errWorkStorage
		}
	}
	if err = journal.db.QueryRowContext(ctx, "PRAGMA journal_mode=WAL").Scan(&check); err != nil || check != "wal" {
		return nil, errWorkStorage
	}
	journal.incarnation, err = workRandomIdentity()
	if err != nil {
		return nil, err
	}
	failed = false
	return journal, nil
}

func (journal *workJournal) close() error {
	var result error
	if journal.db != nil {
		result = journal.db.Close()
	}
	if journal.lock != nil {
		result = errors.Join(result, journal.lock.Close())
	}
	return result
}

func workPrivateOwner(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Getuid()) && info.Mode().Perm()&0077 == 0
}

func workPrivateFile(path string, flags int) (*os.File, error) {
	fd, err := unix.Open(path, flags|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, errWorkUnsafe
	}
	file := os.NewFile(uintptr(fd), path)
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || !workPrivateOwner(info) {
		_ = file.Close()
		return nil, errWorkUnsafe
	}
	return file, nil
}

func workOptionalFile(path string) (bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil || !info.Mode().IsRegular() || !workPrivateOwner(info) {
		return false, errWorkUnsafe
	}
	return true, nil
}

func workRandomIdentity() (string, error) {
	var data [32]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", errWorkStorage
	}
	return hex.EncodeToString(data[:]), nil
}

func readWorkIdentity(path string) (string, error) {
	file, err := workPrivateFile(path, unix.O_RDONLY)
	if err != nil {
		return "", err
	}
	defer func() { _ = file.Close() }()
	data, err := io.ReadAll(io.LimitReader(file, int64(len(workIdentityPrefix)+66)))
	if err != nil || len(data) != len(workIdentityPrefix)+65 || !strings.HasPrefix(string(data), workIdentityPrefix) || data[len(data)-1] != '\n' {
		return "", errWorkIdentity
	}
	identity := string(data[len(workIdentityPrefix) : len(data)-1])
	decoded, err := hex.DecodeString(identity)
	if err != nil || len(decoded) != 32 || hex.EncodeToString(decoded) != identity {
		return "", errWorkIdentity
	}
	return identity, nil
}

func writeWorkIdentity(path, identity string) error {
	file, err := workPrivateFile(path, unix.O_CREAT|unix.O_EXCL|unix.O_WRONLY)
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	data := []byte(workIdentityPrefix + identity + "\n")
	if count, err := file.Write(data); err != nil || count != len(data) {
		return errWorkStorage
	}
	if file.Sync() != nil || syncWorkDirectory(path) != nil {
		return errWorkStorage
	}
	if file.Close() != nil {
		return errWorkStorage
	}
	return nil
}

func syncWorkDirectory(path string) error {
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return errWorkStorage
	}
	defer func() { _ = directory.Close() }()
	return directory.Sync()
}

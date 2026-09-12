// ABOUTME: Exercises SQLite durability, migration faults and conservative restart recovery.
// ABOUTME: Uses isolated synthetic state and real child-process crashes without touching personal data.

package daemon

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func testPaths(t *testing.T) Paths {
	t.Helper()
	root, err := os.MkdirTemp("/tmp", "bfb-kernel-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	paths, err := StatePaths(root)
	if err != nil {
		t.Fatal(err)
	}
	if err = paths.Prepare(); err != nil {
		t.Fatal(err)
	}
	return paths
}

func openTestStore(t *testing.T, paths Paths) *Store {
	t.Helper()
	s, err := OpenStore(context.Background(), paths)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestWALTransactionsAndRestartRecovery(t *testing.T) {
	p := testPaths(t)
	s := openTestStore(t, p)
	var mode string
	if err := s.DB.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil || mode != "wal" {
		t.Fatalf("journal %q: %v", mode, err)
	}
	var enabled int
	if err := s.DB.QueryRow("PRAGMA foreign_keys").Scan(&enabled); err != nil || enabled != 1 {
		t.Fatalf("foreign keys %d: %v", enabled, err)
	}
	if err := s.DB.QueryRow("PRAGMA synchronous").Scan(&enabled); err != nil || enabled != 2 {
		t.Fatalf("sync mode %d: %v", enabled, err)
	}
	if _, err := s.DB.Exec("INSERT INTO process_observations VALUES ('fixture-active', 100, 'synthetic-start', 'attached'), ('fixture-ended', 200, 'synthetic-start', 'ended')"); err != nil {
		t.Fatal(err)
	}
	tx, err := s.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec("INSERT INTO process_observations VALUES ('rolled-back', 300, 'synthetic-start', 'attached')"); err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s = openTestStore(t, p)
	defer s.Close()
	count, err := s.RecoveryPending(context.Background())
	if err != nil || count != 1 {
		t.Fatalf("recovery %d: %v", count, err)
	}
	if err = s.DB.QueryRow("SELECT count(*) FROM process_observations").Scan(&count); err != nil || count != 2 {
		t.Fatalf("records %d: %v", count, err)
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err = ValidateFileMode(p.Database + suffix); err != nil {
			t.Fatal(suffix, err)
		}
	}
}

func TestMigrationRollbackAndChecksum(t *testing.T) {
	p := testPaths(t)
	_, err := openStore(context.Background(), p, kernelMigrations(), func(int) error { return errors.New("synthetic-private-content") })
	if AsFailure(err).Code != "storage_failed" || strings.Contains(err.Error(), "private-content") {
		t.Fatalf("unbounded error: %v", err)
	}
	s := openTestStore(t, p)
	_ = s.Close()
	changed := kernelMigrations()
	changed[0].sql += "\n-- altered fixture\n"
	_, err = openStore(context.Background(), p, changed, nil)
	if err == nil || AsFailure(err).Code != "migration_mismatch" {
		t.Fatalf("checksum: %v", err)
	}
	s = openTestStore(t, p)
	future := StorageVersion + 1
	if _, err = s.DB.Exec("INSERT INTO schema_migrations VALUES (?, ?, 'future')", future, fmt.Sprintf("%03d_future.sql", future)); err != nil {
		t.Fatal(err)
	}
	_ = s.Close()
	_, err = OpenStore(context.Background(), p)
	if err == nil || AsFailure(err).Code != "migration_mismatch" {
		t.Fatalf("newer DB: %v", err)
	}
}

func TestCleanupMigrationPreservesOriginalClaimAndRollsBack(t *testing.T) {
	ctx := context.Background()
	paths := testPaths(t)
	previous, err := openStore(ctx, paths, kernelMigrations()[:4], nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = previous.DB.Exec(`INSERT INTO execution_commands VALUES ('runner','command','workspace','launch',
'2026-09-12T12:02:00Z','2026-09-12T12:00:00Z','original-claim','2026-09-12T12:00:00Z','waiting',NULL)`); err != nil {
		t.Fatal(err)
	}
	_ = previous.Close()
	if _, err = openStore(ctx, paths, kernelMigrations(), func(version int) error {
		if version == 5 {
			return errors.New("synthetic cleanup migration interruption")
		}
		return nil
	}); err == nil {
		t.Fatal("cleanup migration ignored interruption")
	}
	previous, err = openStore(ctx, paths, kernelMigrations()[:4], nil)
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err = previous.DB.QueryRow("SELECT count(*) FROM pragma_table_info('execution_commands') WHERE name = 'cleanup_lock_id'").Scan(&count); err != nil || count != 0 {
		t.Fatal("partial cleanup migration survived rollback", err)
	}
	_ = previous.Close()
	upgraded := openTestStore(t, paths)
	defer upgraded.Close()
	if err = upgraded.DB.QueryRow(`SELECT count(*) FROM execution_commands WHERE claim_key = 'original-claim'
AND claim_started_at = '2026-09-12T12:00:00Z' AND state = 'waiting' AND cleanup_lock_id IS NULL`).Scan(&count); err != nil || count != 1 {
		t.Fatal("cleanup migration changed original claim", err)
	}
}

func TestObservationMigrationPreservesPriorSequencesAndRollsBack(t *testing.T) {
	ctx := context.Background()
	paths := testPaths(t)
	previous, err := openStore(ctx, paths, kernelMigrations()[:5], nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = previous.DB.Exec(`INSERT INTO execution_commands
(runner_id,command_id,workspace_id,command_kind,expires_at,received_at,claim_key,claim_started_at,state)
VALUES ('runner','command','workspace','launch','2026-09-12T12:02:00Z','2026-09-12T12:00:00Z',
'original-claim','2026-09-12T12:00:00Z','waiting');
INSERT INTO local_execution_assignments(execution_id,assignment_generation,workspace_id,project_id,task_id,run_id,
runner_id,checkout_id,launch_id,intent_id,physical_worktree_hash,fencing_generation,claim_json,provider_identity_hash,
correlation_token,created_at,expires_at,state,event_sequence,lease_sequence)
VALUES ('execution',1,'workspace','project','task','run','runner','checkout','command','intent','physical',2,'{}',
'provider','correlation','2026-09-12T12:00:00Z','2026-09-12T12:02:00Z','group_ready',0,9)`); err != nil {
		t.Fatal(err)
	}
	_ = previous.Close()
	if _, err = openStore(ctx, paths, kernelMigrations(), func(version int) error {
		if version == 6 {
			return errors.New("synthetic observation migration interruption")
		}
		return nil
	}); err == nil {
		t.Fatal("observation migration ignored interruption")
	}
	previous, err = openStore(ctx, paths, kernelMigrations()[:5], nil)
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err = previous.DB.QueryRow("SELECT count(*) FROM pragma_table_info('local_execution_assignments') WHERE name = 'provider_observed_at'").Scan(&count); err != nil || count != 0 {
		t.Fatal("partial observation migration survived rollback", err)
	}
	_ = previous.Close()
	upgraded := openTestStore(t, paths)
	defer upgraded.Close()
	if err = upgraded.DB.QueryRow(`SELECT count(*) FROM local_execution_assignments
WHERE state = 'group_ready' AND assignment_generation = 1 AND fencing_generation = 2 AND event_sequence = 0 AND lease_sequence = 9
AND provider_observed_at IS NULL AND process_absent_at IS NULL AND last_process_observed_at IS NULL`).Scan(&count); err != nil || count != 1 {
		t.Fatal("observation migration changed execution identity or invented history", err)
	}
}

func TestExecutionMigrationPreservesPriorStateAndRollsBack(t *testing.T) {
	paths := testPaths(t)
	previous, err := openStore(context.Background(), paths, kernelMigrations()[:3], nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = previous.DB.Exec("INSERT INTO process_observations VALUES ('preserved-execution', 123, 'synthetic', 'ended')"); err != nil {
		t.Fatal(err)
	}
	_ = previous.Close()
	_, err = openStore(context.Background(), paths, kernelMigrations(), func(version int) error {
		if version == 4 {
			return errors.New("synthetic execution migration interruption")
		}
		return nil
	})
	if err == nil {
		t.Fatal("execution migration interruption was ignored")
	}
	previous, err = openStore(context.Background(), paths, kernelMigrations()[:3], nil)
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err = previous.DB.QueryRow("SELECT count(*) FROM sqlite_master WHERE name = 'local_execution_assignments'").Scan(&count); err != nil || count != 0 {
		t.Fatal("partial execution migration survived rollback", err)
	}
	_ = previous.Close()
	upgraded := openTestStore(t, paths)
	defer upgraded.Close()
	if err = upgraded.DB.QueryRow("SELECT count(*) FROM process_observations WHERE id = 'preserved-execution' AND state = 'ended'").Scan(&count); err != nil || count != 1 {
		t.Fatal("execution migration lost prior state", err)
	}
	if err = upgraded.DB.QueryRow("SELECT count(*) FROM schema_migrations").Scan(&count); err != nil || count != StorageVersion {
		t.Fatal("execution migration head mismatch", err)
	}
}

func TestCheckoutMigrationUpgradesKernelAndRollsBackAtomically(t *testing.T) {
	p := testPaths(t)
	previous, err := openStore(context.Background(), p, kernelMigrations()[:1], nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = previous.DB.Exec("INSERT INTO process_observations VALUES ('preserved', 123, 'synthetic-start', 'ended')"); err != nil {
		t.Fatal(err)
	}
	_ = previous.Close()
	_, err = openStore(context.Background(), p, kernelMigrations(), func(version int) error {
		if version == 2 {
			return errors.New("synthetic interrupted migration")
		}
		return nil
	})
	if err == nil {
		t.Fatal("migration fault was ignored")
	}
	previous, err = openStore(context.Background(), p, kernelMigrations()[:1], nil)
	if err != nil {
		t.Fatal("failed migration prevented opening old schema", err)
	}
	var count int
	if err = previous.DB.QueryRow("SELECT count(*) FROM sqlite_master WHERE name = 'checkouts'").Scan(&count); err != nil || count != 0 {
		t.Fatal("partial checkout schema survived rollback")
	}
	_ = previous.Close()
	upgraded := openTestStore(t, p)
	defer upgraded.Close()
	if err = upgraded.DB.QueryRow("SELECT count(*) FROM process_observations WHERE id = 'preserved'").Scan(&count); err != nil || count != 1 {
		t.Fatalf("upgrade lost kernel data: %v", err)
	}
	if err = upgraded.DB.QueryRow("SELECT count(*) FROM checkouts").Scan(&count); err != nil || count != 0 {
		t.Fatalf("checkout schema unavailable: %v", err)
	}
}

func TestCorruptAndForeignDatabasePreserved(t *testing.T) {
	p := testPaths(t)
	canary := []byte("synthetic-private-corrupt-database")
	if err := os.WriteFile(p.Database, canary, 0600); err != nil {
		t.Fatal(err)
	}
	_, err := OpenStore(context.Background(), p)
	if err == nil || AsFailure(err).Code != "storage_failed" {
		t.Fatalf("corruption: %v", err)
	}
	after, _ := os.ReadFile(p.Database)
	if string(after) != string(canary) {
		t.Fatal("corrupt bytes changed")
	}
	p = testPaths(t)
	s := openTestStore(t, p)
	if _, err = s.DB.Exec("PRAGMA application_id=12345"); err != nil {
		t.Fatal(err)
	}
	_ = s.Close()
	if _, err = OpenStore(context.Background(), p); err == nil {
		t.Fatal("accepted foreign application")
	}
}

func TestRunnerMigrationUpgradesCheckoutHeadAndRollsBackAtomically(t *testing.T) {
	paths := testPaths(t)
	previous, err := openStore(context.Background(), paths, kernelMigrations()[:2], nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = previous.DB.Exec("INSERT INTO process_observations VALUES ('l08-preserved', 123, 'synthetic-start', 'ended')"); err != nil {
		t.Fatal(err)
	}
	_ = previous.Close()
	_, err = openStore(context.Background(), paths, kernelMigrations(), func(version int) error {
		if version == 3 {
			return errors.New("synthetic runner migration interruption")
		}
		return nil
	})
	if err == nil {
		t.Fatal("runner migration interruption ignored")
	}
	previous, err = openStore(context.Background(), paths, kernelMigrations()[:2], nil)
	if err != nil {
		t.Fatal("previous checkout head could not reopen", err)
	}
	var count int
	if err = previous.DB.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('runner_enrollments', 'runner_command_inbox')").Scan(&count); err != nil || count != 0 {
		t.Fatal("partial runner tables survived", count, err)
	}
	_ = previous.Close()
	upgraded := openTestStore(t, paths)
	defer upgraded.Close()
	if err = upgraded.DB.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('checkouts', 'runner_enrollments', 'runner_command_inbox')").Scan(&count); err != nil || count != 3 {
		t.Fatal("runner upgrade missing schema", count, err)
	}
	if err = upgraded.DB.QueryRow("SELECT COUNT(*) FROM process_observations WHERE id = 'l08-preserved'").Scan(&count); err != nil || count != 1 {
		t.Fatal("runner upgrade lost existing state", count, err)
	}
}

func TestStorageRejectsSymlinksAndPublicFiles(t *testing.T) {
	for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
		t.Run("symlink"+suffix, func(t *testing.T) {
			p := testPaths(t)
			target := filepath.Join(p.Root, "untouched")
			if err := os.WriteFile(target, []byte("synthetic-canary"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, p.Database+suffix); err != nil {
				t.Fatal(err)
			}
			if _, err := OpenStore(context.Background(), p); err == nil {
				t.Fatal("accepted symlink")
			}
			content, _ := os.ReadFile(target)
			if string(content) != "synthetic-canary" {
				t.Fatal("changed symlink target")
			}
		})
	}
	p := testPaths(t)
	if err := os.WriteFile(p.Database, nil, 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p.Database, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenStore(context.Background(), p); err == nil {
		t.Fatal("accepted non-private database")
	}
}

func TestProcessCrashAtMigrationBoundary(t *testing.T) {
	p := testPaths(t)
	command := exec.Command(os.Args[0], "-test.run=^TestStoreCrashHelper$")
	command.Env = append(os.Environ(), "BFB_DAEMON_TEST_MODE=migration", "BFB_DAEMON_TEST_ROOT="+p.Root)
	err := command.Run()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 73 {
		t.Fatalf("crash helper: %v", err)
	}
	s := openTestStore(t, p)
	defer s.Close()
	var count int
	if err = s.DB.QueryRow("SELECT count(*) FROM schema_migrations").Scan(&count); err != nil || count != StorageVersion {
		t.Fatalf("migration recovery %d: %v", count, err)
	}
}

func TestProcessCrashKeepsCommittedTransactionOnly(t *testing.T) {
	p := testPaths(t)
	command := exec.Command(os.Args[0], "-test.run=^TestStoreCrashHelper$")
	command.Env = append(os.Environ(), "BFB_DAEMON_TEST_MODE=transaction", "BFB_DAEMON_TEST_ROOT="+p.Root)
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = command.Process.Kill() })
	line, err := bufio.NewReader(output).ReadString('\n')
	if err != nil || line != "ready\n" {
		t.Fatalf("helper readiness %q: %v", line, err)
	}
	if err = command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = command.Wait()
	s := openTestStore(t, p)
	defer s.Close()
	var count int
	if err = s.DB.QueryRow("SELECT count(*) FROM process_observations").Scan(&count); err != nil || count != 1 {
		t.Fatalf("transaction recovery %d: %v", count, err)
	}
	if count, err = s.RecoveryPending(context.Background()); err != nil || count != 1 {
		t.Fatalf("unknown recovery %d: %v", count, err)
	}
}

func TestStoreCrashHelper(t *testing.T) {
	mode := os.Getenv("BFB_DAEMON_TEST_MODE")
	if mode == "" {
		return
	}
	p, err := StatePaths(os.Getenv("BFB_DAEMON_TEST_ROOT"))
	if err != nil {
		t.Fatal(err)
	}
	if mode == "migration" {
		_, _ = openStore(context.Background(), p, kernelMigrations(), func(int) error { os.Exit(73); return nil })
		t.Fatal("migration did not reach crash point")
	}
	s := openTestStore(t, p)
	if _, err = s.DB.Exec("INSERT INTO process_observations VALUES ('committed', 123, 'synthetic-start', 'attached')"); err != nil {
		t.Fatal(err)
	}
	tx, err := s.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec("INSERT INTO process_observations VALUES ('uncommitted', 456, 'synthetic-start', 'attached')"); err != nil {
		t.Fatal(err)
	}
	_, _ = os.Stdout.WriteString("ready\n")
	select {}
}

func TestStateDirectoryWithLiteralSpacesAndUnicode(t *testing.T) {
	p := testPaths(t)
	literal, err := StatePaths(filepath.Join(p.Root, "space & '雪'"))
	if err != nil {
		t.Fatal(err)
	}
	if err = literal.Prepare(); err != nil {
		t.Fatal(err)
	}
	s := openTestStore(t, literal)
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(literal.Database); err != nil {
		t.Fatal("URI did not preserve literal path", err)
	}
}

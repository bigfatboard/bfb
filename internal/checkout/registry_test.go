// ABOUTME: Exercises exact checkout identity and lifecycle on real Git repositories and filesystems.
// ABOUTME: Proves alias rejection, replacement fencing, policy changes, persistence and zero Git mutation.

package checkout

import (
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
)

const workspaceID = "01JBFB0W0RKSPACE0000000000"
const runnerID = "01JBFB0RVNNER1D00000000000"
const projectID = "01JBFB0PR0JECTX00000000000"

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func requireFailure(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil || daemon.AsFailure(err).Code != code {
		t.Fatalf("wanted %s, got %v", code, err)
	}
}

func writeFixture(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	must(t, os.WriteFile(path, []byte(content), mode))
}

func fixtureGit(t *testing.T, root string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, gitBinary, append([]string{"-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false"}, args...)...)
	command.Dir = root
	command.Env = []string{"PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_AUTHOR_NAME=Synthetic", "GIT_AUTHOR_EMAIL=fixture@example.test", "GIT_COMMITTER_NAME=Synthetic", "GIT_COMMITTER_EMAIL=fixture@example.test"}
	data, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("fixture Git %v: %v %s", args, err, data)
	}
	return strings.TrimSpace(string(data))
}

func fixtureRepositoryAt(t *testing.T, root string, committed bool) {
	t.Helper()
	must(t, os.MkdirAll(filepath.Join(root, "packages", "api"), 0700))
	fixtureGit(t, root, "init", "--initial-branch=main")
	fixtureGit(t, root, "remote", "add", "origin", "https://synthetic:synthetic-secret@github.com/QDIS/BFB.git")
	if committed {
		writeFixture(t, filepath.Join(root, "README.md"), "Synthetic repository\n", 0600)
		writeFixture(t, filepath.Join(root, "packages", "api", "fixture.txt"), "Synthetic subproject\n", 0600)
		fixtureGit(t, root, "add", ".")
		fixtureGit(t, root, "commit", "-m", "synthetic fixture")
	}
}

func fixtureRepository(t *testing.T, committed bool) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "ExactCheckout")
	fixtureRepositoryAt(t, root, committed)
	return root
}

func fixturePaths(t *testing.T) daemon.Paths {
	t.Helper()
	root, err := os.MkdirTemp("/tmp", "bfb-checkout-")
	must(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	paths, err := daemon.StatePaths(root)
	must(t, err)
	must(t, paths.Prepare())
	return paths
}

func fixtureRegistry(t *testing.T) (*Registry, *daemon.Store, daemon.Paths) {
	t.Helper()
	paths := fixturePaths(t)
	store, err := daemon.OpenStore(context.Background(), paths)
	must(t, err)
	t.Cleanup(func() { _ = store.Close() })
	return NewRegistry(store.DB), store, paths
}

func linkInput(root string) LinkInput {
	return LinkInput{WorkspaceID: workspaceID, RunnerID: runnerID, ProjectID: projectID, Path: root, RepositoryIdentity: "github.com/qdis/bfb", Label: "Synthetic checkout", WorkspaceSubpath: "."}
}

func TestExecutionDirectoryPinsExactRegisteredIdentity(t *testing.T) {
	registry, _, _ := fixtureRegistry(t)
	root := fixtureRepository(t, true)
	record, err := registry.Link(context.Background(), linkInput(root))
	must(t, err)
	directory, err := OpenExecutionDirectory(record.Location)
	must(t, err)
	defer directory.Close()
	before, err := directory.Stat()
	must(t, err)
	must(t, os.Rename(root, root+".original"))
	must(t, os.Mkdir(root, 0700))
	if replaced, err := OpenExecutionDirectory(record.Location); err == nil {
		_ = replaced.Close()
		t.Fatal("replacement directory accepted for execution")
	}
	after, err := directory.Stat()
	must(t, err)
	current, err := os.Stat(root)
	must(t, err)
	if !os.SameFile(before, after) || os.SameFile(after, current) {
		t.Fatal("execution descriptor changed identity with its path")
	}
}

type metadataEntry struct {
	Mode     fs.FileMode
	Modified time.Time
	Content  string
}

func metadataSnapshot(t *testing.T, root string) map[string]metadataEntry {
	t.Helper()
	result := map[string]metadataEntry{}
	must(t, filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		key, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		value := metadataEntry{Mode: info.Mode(), Modified: info.ModTime()}
		if info.Mode().IsRegular() {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			value.Content = string(data)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			value.Content = target
		}
		result[key] = value
		return nil
	}))
	return result
}

func assertSanitized(t *testing.T, value any, privatePaths ...string) {
	t.Helper()
	data, err := json.Marshal(value)
	must(t, err)
	for _, private := range append(privatePaths, "synthetic-secret", "registered_path", "working_directory", "git_common_directory") {
		if strings.Contains(string(data), private) {
			t.Fatal("private checkout data leaked")
		}
	}
}

func TestExactRootAliasesAndReadOnlyGit(t *testing.T) {
	ctx := context.Background()
	root := fixtureRepository(t, true)
	registry, _, _ := fixtureRegistry(t)
	canary := filepath.Join(t.TempDir(), "executed")
	hook := filepath.Join(t.TempDir(), "monitor.sh")
	writeFixture(t, hook, "#!/bin/sh\n# ABOUTME: Synthetic invocation canary.\n# ABOUTME: Creates a marker only if an observer executes it.\ntouch '"+canary+"'\nexit 1\n", 0700)
	fixtureGit(t, root, "config", "core.fsmonitor", hook)
	fixtureGit(t, root, "config", "core.sshCommand", hook)
	fixtureGit(t, root, "config", "core.untrackedCache", "true")
	before := metadataSnapshot(t, filepath.Join(root, ".git"))
	t.Setenv("GIT_DIR", "/synthetic/poisoned-git")
	t.Setenv("GIT_WORK_TREE", "/synthetic/poisoned-worktree")
	t.Setenv("GIT_INDEX_FILE", canary)
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "remote.origin.url")
	t.Setenv("GIT_CONFIG_VALUE_0", "https://github.com/other/repo")
	record, err := registry.Link(ctx, linkInput(root))
	must(t, err)
	if record.Summary.Dirty || textValue(record.Summary.Branch) != "main" || len(textValue(record.Summary.Head)) != 40 || record.Summary.Status != "validated" {
		t.Fatal("incorrect clean observation")
	}
	canonical, _, err := canonicalDirectory(root)
	must(t, err)
	if record.Location.WorkingDirectory != canonical || record.Location.GitRoot != canonical || record.Location.GitDirectory != record.Location.GitCommonDirectory {
		t.Fatal("incorrect root topology")
	}
	data, err := json.Marshal(record.Summary)
	must(t, err)
	if !protocol.DecodeWireDocument("checkout-summary", data).OK {
		t.Fatal("summary does not satisfy wire schema")
	}
	assertSanitized(t, record, root, canonical)
	alias := filepath.Join(t.TempDir(), "alias")
	must(t, os.Symlink(root, alias))
	input := linkInput(alias)
	input.ProjectID = daemon.NewRequestID()
	input.RunnerID = daemon.NewRequestID()
	_, err = registry.Link(ctx, input)
	requireFailure(t, err, "checkout_already_linked")
	input = linkInput(filepath.Join(root, "packages", "api"))
	input.WorkspaceSubpath = "packages/api"
	_, err = registry.Link(ctx, input)
	requireFailure(t, err, "checkout_already_linked")
	_, err = registry.Verify(ctx, record.Summary.CheckoutId)
	must(t, err)
	writeFixture(t, filepath.Join(root, "README.md"), "Dirty synthetic content\n", 0600)
	dirty, err := registry.Verify(ctx, record.Summary.CheckoutId)
	must(t, err)
	if !dirty.Summary.Dirty {
		t.Fatal("dirty tree not observed")
	}
	must(t, registry.Unlink(ctx, record.Summary.CheckoutId))
	after := metadataSnapshot(t, filepath.Join(root, ".git"))
	if !reflect.DeepEqual(before, after) {
		t.Fatal("read-only registry mutated Git bytes, modes, timestamps or entries")
	}
	if _, err = os.Stat(canary); !os.IsNotExist(err) {
		t.Fatal("Git executed inherited authority")
	}
}

func TestSubdirectoryLinkedWorktreeAndGitStates(t *testing.T) {
	ctx := context.Background()
	root := fixtureRepository(t, true)
	registry, _, _ := fixtureRegistry(t)
	input := linkInput(filepath.Join(root, "packages", "api"))
	input.WorkspaceSubpath = "packages/api"
	subproject, err := registry.Link(ctx, input)
	must(t, err)
	if subproject.Location.WorkspaceSubpath != "packages/api" {
		t.Fatal("lost project subpath")
	}
	worktree := filepath.Join(t.TempDir(), "linked")
	fixtureGit(t, root, "worktree", "add", "-b", "feature/synthetic", worktree)
	before := metadataSnapshot(t, filepath.Join(root, ".git"))
	linked, err := registry.Link(ctx, linkInput(worktree))
	must(t, err)
	if linked.Location.GitCommonDirectory != subproject.Location.GitCommonDirectory || linked.Location.GitDirectory == subproject.Location.GitDirectory || linked.Summary.PhysicalWorktreeHash == subproject.Summary.PhysicalWorktreeHash {
		t.Fatal("linked worktree identity collapsed")
	}
	if !reflect.DeepEqual(before, metadataSnapshot(t, filepath.Join(root, ".git"))) {
		t.Fatal("linked observation mutated common directory")
	}
	fixtureGit(t, worktree, "checkout", "--detach")
	detached, err := registry.Verify(ctx, linked.Summary.CheckoutId)
	must(t, err)
	if detached.Summary.Branch != nil || detached.Summary.Head == nil {
		t.Fatal("detached HEAD misclassified")
	}
	unborn, err := Observe(ctx, fixtureRepository(t, false), "origin")
	must(t, err)
	if unborn.Head != "" || unborn.Branch != "main" {
		t.Fatal("unborn branch misclassified")
	}
	bare := t.TempDir()
	fixtureGit(t, bare, "init", "--bare")
	_, err = Observe(ctx, bare, "origin")
	requireFailure(t, err, "checkout_not_worktree")
	input = linkInput(root)
	input.WorkspaceSubpath = "wrong"
	_, err = registry.Link(ctx, input)
	requireFailure(t, err, "checkout_subpath_mismatch")
	input = linkInput(root)
	input.RepositoryIdentity = "github.com/other/repo"
	_, err = registry.Link(ctx, input)
	requireFailure(t, err, "checkout_repository_mismatch")
}

func TestMissingReplacedAndRetargetedCheckouts(t *testing.T) {
	for _, kind := range []string{"missing", "root-replaced", "subdirectory-replaced", "alias-retargeted", "git-directory-replaced", "remote-changed"} {
		t.Run(kind, func(t *testing.T) {
			ctx := context.Background()
			root := fixtureRepository(t, true)
			registry, _, _ := fixtureRegistry(t)
			input := linkInput(root)
			if kind == "subdirectory-replaced" {
				input.Path = filepath.Join(root, "packages", "api")
				input.WorkspaceSubpath = "packages/api"
			}
			if kind == "alias-retargeted" {
				input.Path = filepath.Join(t.TempDir(), "alias")
				must(t, os.Symlink(root, input.Path))
			}
			record, err := registry.Link(ctx, input)
			must(t, err)
			code := "checkout_identity_changed"
			switch kind {
			case "missing":
				must(t, os.Rename(root, root+"-moved"))
				code = "checkout_path_missing"
			case "root-replaced":
				must(t, os.Rename(root, root+"-old"))
				fixtureRepositoryAt(t, root, true)
			case "subdirectory-replaced":
				must(t, os.Rename(input.Path, input.Path+"-old"))
				must(t, os.Mkdir(input.Path, 0700))
			case "alias-retargeted":
				must(t, os.Remove(input.Path))
				must(t, os.Symlink(fixtureRepository(t, true), input.Path))
			case "git-directory-replaced":
				old := filepath.Join(root, ".git")
				must(t, os.Rename(old, old+"-old"))
				fixtureGit(t, root, "init", "--initial-branch=main")
				fixtureGit(t, root, "remote", "add", "origin", "https://github.com/qdis/bfb")
			case "remote-changed":
				fixtureGit(t, root, "remote", "set-url", "origin", "git@github.com:other/repo.git")
				code = "checkout_repository_mismatch"
			}
			_, err = registry.Revalidate(ctx, record.Summary.CheckoutId)
			requireFailure(t, err, code)
			blocked, err := registry.Verify(ctx, record.Summary.CheckoutId)
			requireFailure(t, err, code)
			if blocked.Summary.Status != "blocked" || textValue(blocked.Summary.BlockReason) != code {
				t.Fatal("missing persisted block")
			}
			assertSanitized(t, blocked, root)
		})
	}
}

func TestConfigRefreshCannotAuthorizeOldOrWiderSpecification(t *testing.T) {
	ctx := context.Background()
	root := fixtureRepository(t, true)
	registry, _, _ := fixtureRegistry(t)
	record, err := registry.Link(ctx, linkInput(root))
	must(t, err)
	parent := Policy{AllowedProviders: []string{"codex"}}
	_, err = registry.RevalidateForExecution(ctx, record.Summary.CheckoutId, record.Config.Hash, parent)
	must(t, err)
	must(t, os.Mkdir(filepath.Join(root, ".bfb"), 0700))
	path := filepath.Join(root, ".bfb", "config.yaml")
	writeFixture(t, path, "allowed_providers: [codex]\n", 0600)
	_, err = registry.Revalidate(ctx, record.Summary.CheckoutId)
	requireFailure(t, err, "checkout_config_changed")
	changed, err := registry.Verify(ctx, record.Summary.CheckoutId)
	requireFailure(t, err, "checkout_config_changed")
	if changed.Summary.Status != "stale" || changed.Config.Hash == record.Config.Hash {
		t.Fatal("config change not exposed")
	}
	_, err = registry.Verify(ctx, record.Summary.CheckoutId)
	must(t, err)
	_, err = registry.RevalidateForExecution(ctx, record.Summary.CheckoutId, record.Config.Hash, parent)
	requireFailure(t, err, "checkout_config_changed")
	_, err = registry.RevalidateForExecution(ctx, record.Summary.CheckoutId, changed.Config.Hash, parent)
	must(t, err)
	writeFixture(t, path, "allow_pass_to_agent: true\n", 0600)
	widened, err := registry.Verify(ctx, record.Summary.CheckoutId)
	requireFailure(t, err, "checkout_config_changed")
	_, err = registry.RevalidateForExecution(ctx, record.Summary.CheckoutId, widened.Config.Hash, parent)
	requireFailure(t, err, "checkout_policy_widening")
	writeFixture(t, path, "provider_token: synthetic-secret\n", 0600)
	_, err = registry.Verify(ctx, record.Summary.CheckoutId)
	requireFailure(t, err, "checkout_config_invalid")
}

func TestCommonDirectoryRetargetAndBoundedObservation(t *testing.T) {
	ctx := context.Background()
	root := fixtureRepository(t, true)
	worktree := filepath.Join(t.TempDir(), "linked")
	fixtureGit(t, root, "worktree", "add", "-b", "feature/synthetic", worktree)
	registry, _, _ := fixtureRegistry(t)
	record, err := registry.Link(ctx, linkInput(worktree))
	must(t, err)
	other := fixtureRepository(t, true)
	writeFixture(t, filepath.Join(record.Location.GitDirectory, "commondir"), filepath.Join(other, ".git")+"\n", 0600)
	_, err = registry.Revalidate(ctx, record.Summary.CheckoutId)
	requireFailure(t, err, "checkout_identity_changed")
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	_, err = Observe(cancelled, root, "origin")
	requireFailure(t, err, "checkout_git_unavailable")
	_, err = Observe(ctx, ".", "origin")
	requireFailure(t, err, "checkout_path_unsafe")
	_, err = Observe(ctx, root, "--unsafe")
	requireFailure(t, err, "invalid_request")
	var output boundedOutput
	output.limit = 4
	if _, err = output.Write([]byte("five!")); err == nil || !output.exceeded || output.Len() != 0 {
		t.Fatal("Git output limit did not fail closed")
	}
}

func TestConcurrentLinksDefaultsPaginationAndRestart(t *testing.T) {
	ctx := context.Background()
	root := fixtureRepository(t, true)
	registry, store, paths := fixtureRegistry(t)
	var group sync.WaitGroup
	results := make(chan error, 4)
	for range 4 {
		group.Go(func() { _, err := registry.Link(ctx, linkInput(root)); results <- err })
	}
	group.Wait()
	close(results)
	successes := 0
	for err := range results {
		if err == nil {
			successes++
		} else {
			requireFailure(t, err, "checkout_already_linked")
		}
	}
	if successes != 1 {
		t.Fatal("physical worktree linked more than once")
	}
	input := linkInput(fixtureRepository(t, true))
	input.IsDefault = true
	firstDefault, err := registry.Link(ctx, input)
	must(t, err)
	nextRoot := fixtureRepository(t, true)
	input.Path = nextRoot
	_, err = registry.Link(ctx, input)
	requireFailure(t, err, "checkout_default_conflict")
	input.IsDefault = false
	_, err = registry.Link(ctx, input)
	must(t, err)
	page, next, err := registry.List(ctx, ListOptions{WorkspaceID: workspaceID, Limit: 2})
	must(t, err)
	if len(page) != 2 || next == "" {
		t.Fatal("first page invalid")
	}
	page2, next2, err := registry.List(ctx, ListOptions{After: next, Limit: 2})
	must(t, err)
	if len(page2) != 1 || next2 != "" || page2[0].CheckoutId <= next {
		t.Fatal("cursor invalid")
	}
	empty, _, err := registry.List(ctx, ListOptions{ProjectID: daemon.NewRequestID()})
	must(t, err)
	if len(empty) != 0 {
		t.Fatal("project filter ignored")
	}
	_, _, err = registry.List(ctx, ListOptions{Limit: 26})
	requireFailure(t, err, "invalid_request")
	must(t, registry.Unlink(ctx, firstDefault.Summary.CheckoutId))
	must(t, registry.Unlink(ctx, firstDefault.Summary.CheckoutId))
	_, err = registry.Get(ctx, firstDefault.Summary.CheckoutId)
	requireFailure(t, err, "checkout_not_found")
	var tombstones int
	must(t, store.DB.QueryRow("SELECT count(*) FROM checkouts WHERE unlinked_at IS NOT NULL").Scan(&tombstones))
	if tombstones != 1 {
		t.Fatal("unlink destroyed history")
	}
	must(t, store.Close())
	reopened, err := daemon.OpenStore(ctx, paths)
	must(t, err)
	defer reopened.Close()
	restarted := NewRegistry(reopened.DB)
	input = linkInput(firstDefault.Location.RegisteredPath)
	input.IsDefault = true
	relinked, err := restarted.Link(ctx, input)
	must(t, err)
	if relinked.Summary.CheckoutId == firstDefault.Summary.CheckoutId {
		t.Fatal("relink revived old identity")
	}
	items, _, err := restarted.List(ctx, ListOptions{})
	must(t, err)
	if len(items) != 3 {
		t.Fatal("restart lost registrations")
	}
	must(t, func() error {
		_, err := reopened.DB.Exec("UPDATE checkouts SET validated_at = '2020-01-01T00:00:00Z'")
		return err
	}())
	items, _, err = restarted.List(ctx, ListOptions{})
	must(t, err)
	for _, item := range items {
		if item.Status != "stale" {
			t.Fatal("old observation advertised as fresh")
		}
	}
}

// ABOUTME: Observes exact Git worktrees using fixed read-only commands and bounded output.
// ABOUTME: Ignores ambient Git authority, disables optional writes and hooks, and never performs network work.

package checkout

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const gitBinary = "/usr/bin/git"

type Location struct {
	RegisteredPath       string `json:"-"`
	WorkingDirectory     string `json:"-"`
	GitRoot              string `json:"-"`
	GitDirectory         string `json:"-"`
	GitCommonDirectory   string `json:"-"`
	WorkspaceSubpath     string `json:"-"`
	CwdIdentity          string `json:"-"`
	RootIdentity         string `json:"-"`
	GitIdentity          string `json:"-"`
	CommonIdentity       string `json:"-"`
	PhysicalWorktreeHash string `json:"-"`
}

type Observation struct {
	Location           Location `json:"-"`
	RepositoryIdentity string
	Branch             string
	Head               string
	Dirty              bool
	Config             RepositoryConfig
	ValidatedAt        string
}

type boundedOutput struct {
	bytes.Buffer
	limit    int
	exceeded bool
}

func (output *boundedOutput) Write(data []byte) (int, error) {
	if len(data) > output.limit-output.Len() {
		output.exceeded = true
		return 0, errors.New("Git output bound exceeded")
	}
	return output.Buffer.Write(data)
}

func gitCommand(ctx context.Context, directory string, arguments ...string) ([]byte, int, error) {
	fixed := []string{"--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.hooksPath=/dev/null", "-c", "maintenance.auto=false", "-c", "gc.auto=0"}
	command := exec.CommandContext(ctx, gitBinary, append(fixed, arguments...)...)
	command.Dir = directory
	command.Env = []string{
		"PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C",
		"GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_SYSTEM=/dev/null", "GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0",
		"GIT_NO_REPLACE_OBJECTS=1", "GIT_NO_LAZY_FETCH=1",
	}
	var stdout, stderr boundedOutput
	stdout.limit, stderr.limit = 512*1024, 4096
	command.Stdout, command.Stderr = &stdout, &stderr
	command.WaitDelay = time.Second
	err := command.Run()
	if stdout.exceeded || stderr.exceeded || ctx.Err() != nil {
		return nil, -1, failure("checkout_git_unavailable")
	}
	if err == nil {
		return stdout.Bytes(), 0, nil
	}
	var exited *exec.ExitError
	if errors.As(err, &exited) {
		return stdout.Bytes(), exited.ExitCode(), nil
	}
	return nil, -1, failure("checkout_git_unavailable")
}

func readTopology(ctx context.Context, path string) (Location, error) {
	location := Location{RegisteredPath: filepath.Clean(path)}
	var err error
	location.WorkingDirectory, location.CwdIdentity, err = canonicalDirectory(path)
	if err != nil {
		return Location{}, err
	}
	data, code, err := gitCommand(ctx, location.WorkingDirectory, "rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir", "--is-inside-work-tree")
	if err != nil {
		return Location{}, err
	}
	if code != 0 {
		return Location{}, failure("checkout_not_worktree")
	}
	parts := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	if len(parts) != 4 || parts[3] != "true" {
		return Location{}, failure("checkout_not_worktree")
	}
	for _, item := range []struct {
		path                string
		canonical, identity *string
	}{
		{parts[0], &location.GitRoot, &location.RootIdentity},
		{parts[1], &location.GitDirectory, &location.GitIdentity},
		{parts[2], &location.GitCommonDirectory, &location.CommonIdentity},
	} {
		*item.canonical, *item.identity, err = canonicalDirectory(item.path)
		if err != nil {
			return Location{}, err
		}
	}
	subpath, err := filepath.Rel(location.GitRoot, location.WorkingDirectory)
	if err != nil {
		return Location{}, failure("checkout_subpath_mismatch")
	}
	location.WorkspaceSubpath, err = normalizeSubpath(filepath.ToSlash(subpath))
	if err != nil {
		return Location{}, err
	}
	location.PhysicalWorktreeHash = physicalWorktreeHash(location.RootIdentity)
	return location, nil
}

func readRemote(ctx context.Context, directory, remote string) (string, error) {
	data, code, err := gitCommand(ctx, directory, "config", "--null", "--get-all", "remote."+remote+".url")
	if err != nil {
		return "", err
	}
	values := bytes.Split(bytes.TrimSuffix(data, []byte{0}), []byte{0})
	if code != 0 || len(values) != 1 {
		return "", failure("checkout_repository_mismatch")
	}
	return NormalizeRemote(string(values[0]))
}

func readHead(ctx context.Context, directory string) (branch, head string, err error) {
	branchData, branchCode, err := gitCommand(ctx, directory, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil || (branchCode != 0 && branchCode != 1) {
		return "", "", failure("checkout_git_unavailable")
	}
	if branchCode == 0 {
		branch = strings.TrimSuffix(string(branchData), "\n")
		if !validBranch(branch) {
			return "", "", failure("checkout_git_unavailable")
		}
	}
	headData, headCode, err := gitCommand(ctx, directory, "rev-parse", "--verify", "--quiet", "HEAD^{commit}")
	if err != nil {
		return "", "", err
	}
	if headCode == 0 {
		head = strings.TrimSuffix(string(headData), "\n")
		if !headPattern.MatchString(head) {
			return "", "", failure("checkout_git_unavailable")
		}
		return branch, head, nil
	}
	if branch != "" && headCode == 1 {
		_, refCode, refErr := gitCommand(ctx, directory, "show-ref", "--verify", "--quiet", "refs/heads/"+branch)
		if refErr == nil && refCode == 1 {
			return branch, "", nil
		}
	}
	return "", "", failure("checkout_git_unavailable")
}

// Observe does not authorize execution. The caller must compare it with the registered identity.
func Observe(ctx context.Context, path, remote string) (Observation, error) {
	if !remoteNamePattern.MatchString(remote) {
		return Observation{}, failure("invalid_request")
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	location, err := readTopology(ctx, path)
	if err != nil {
		return Observation{}, err
	}
	observed := Observation{Location: location}
	observed.RepositoryIdentity, err = readRemote(ctx, location.WorkingDirectory, remote)
	if err != nil {
		return Observation{}, err
	}
	observed.Branch, observed.Head, err = readHead(ctx, location.WorkingDirectory)
	if err != nil {
		return Observation{}, err
	}
	data, code, err := gitCommand(ctx, location.GitRoot, "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=none")
	if err != nil || code != 0 {
		return Observation{}, failure("checkout_git_unavailable")
	}
	observed.Dirty = len(data) != 0
	observed.Config, err = readRepositoryConfig(location.GitRoot)
	if err != nil {
		return Observation{}, err
	}
	after, err := readTopology(ctx, path)
	if err != nil {
		return Observation{}, err
	}
	if after != location {
		return Observation{}, failure("checkout_identity_changed")
	}
	remoteAfter, err := readRemote(ctx, location.WorkingDirectory, remote)
	if err != nil {
		return Observation{}, err
	}
	if remoteAfter != observed.RepositoryIdentity {
		return Observation{}, failure("checkout_repository_mismatch")
	}
	observed.ValidatedAt = time.Now().UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano)
	return observed, nil
}

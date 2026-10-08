// ABOUTME: Applies explicitly approved provider-owned configuration diffs with local lock and hash checks.
// ABOUTME: Retains a private crash-recovery copy and restores prior bytes when post-write doctor fails.

package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"
)

const maxConfigBytes = 2 * 1024 * 1024

type OwnedDiff struct {
	Namespace string          `json:"namespace"`
	Before    json.RawMessage `json:"before"`
	After     json.RawMessage `json:"after"`
}

// Editors are compiled provider-local code; callers cannot submit a replacement config.
// UnownedSemantics must parse the whole format and canonically exclude only BFB-owned entries.
type ConfigEditor interface {
	Prepare(before []byte) (after []byte, diff OwnedDiff, err error)
	UnownedSemantics(config []byte) ([]byte, error)
}

type SetupProposal struct {
	ID                                    string    `json:"id"`
	ExpectedHash                          string    `json:"expected_hash"`
	Diff                                  OwnedDiff `json:"diff"`
	path, directory, parentIdentity, seal string
	before, after                         []byte
	present                               bool
	mode                                  os.FileMode
}

// Approval is created only by the explicit human setup command, never by telemetry.
type SetupApproval struct {
	Approved                 bool
	ProposalID, ExpectedHash string
}
type Doctor func(context.Context) error

type configDirectory struct {
	root                      *os.Root
	directory, name, identity string
}

func openConfigDirectory(path string) (*configDirectory, error) {
	if !filepath.IsAbs(path) || filepath.Base(path) == "." || filepath.Base(path) == string(filepath.Separator) {
		return nil, Failure("provider_path_unsafe")
	}
	directory, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil {
		return nil, Failure("provider_path_unsafe")
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, Failure("provider_path_unsafe")
	}
	info, err := root.Stat(".")
	if err != nil || !info.IsDir() || info.Mode().Perm()&0022 != 0 {
		_ = root.Close()
		return nil, Failure("provider_path_unsafe")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) {
		_ = root.Close()
		return nil, Failure("provider_path_unsafe")
	}
	identity, _ := json.Marshal([]uint64{uint64(stat.Dev), uint64(stat.Ino)})
	return &configDirectory{root: root, directory: directory, name: filepath.Base(path), identity: string(identity)}, nil
}

func (directory *configDirectory) read(name string) ([]byte, bool, os.FileMode, error) {
	limit := maxConfigBytes
	if name != directory.name {
		limit = 4 * 1024 * 1024
	}
	file, err := directory.root.OpenFile(name, os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if errors.Is(err, os.ErrNotExist) {
		return []byte{}, false, 0600, nil
	}
	if err != nil {
		return nil, false, 0, Failure("provider_path_unsafe")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > int64(limit) || info.Mode().Perm()&0022 != 0 {
		return nil, false, 0, Failure("provider_path_unsafe")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) {
		return nil, false, 0, Failure("provider_path_unsafe")
	}
	data, err := io.ReadAll(io.LimitReader(file, int64(limit)+1))
	after, afterErr := file.Stat()
	current, currentErr := directory.root.Lstat(name)
	if err != nil || len(data) > limit || afterErr != nil || currentErr != nil || !os.SameFile(info, current) || !os.SameFile(info, after) || after.Size() != info.Size() || after.ModTime() != info.ModTime() {
		return nil, false, 0, Failure("provider_setup_conflict")
	}
	return data, true, info.Mode().Perm(), nil
}

func configHash(data []byte, present bool) string {
	marker := byte(0)
	if present {
		marker = 1
	}
	return Hash(append([]byte{marker}, data...))
}

func setupSeal(proposal SetupProposal) string { data, _ := json.Marshal(proposal); return Hash(data) }

func ProposeSetup(path string, editor ConfigEditor) (SetupProposal, error) {
	if editor == nil {
		return SetupProposal{}, Failure("provider_setup_denied")
	}
	directory, err := openConfigDirectory(path)
	if err != nil {
		return SetupProposal{}, err
	}
	defer directory.root.Close()
	before, present, mode, err := directory.read(directory.name)
	if err != nil {
		return SetupProposal{}, err
	}
	after, diff, err := editor.Prepare(bytes.Clone(before))
	if err != nil || len(after) > maxConfigBytes || !namePattern.MatchString(diff.Namespace) || !json.Valid(diff.Before) || !json.Valid(diff.After) || len(diff.Before)+len(diff.After) > MaxHookBytes {
		return SetupProposal{}, Failure("provider_setup_denied")
	}
	unownedBefore, beforeErr := editor.UnownedSemantics(before)
	unownedAfter, afterErr := editor.UnownedSemantics(after)
	if beforeErr != nil || afterErr != nil || !bytes.Equal(unownedBefore, unownedAfter) {
		return SetupProposal{}, Failure("provider_setup_denied")
	}
	proposal := SetupProposal{ExpectedHash: configHash(before, present), Diff: OwnedDiff{diff.Namespace, bytes.Clone(diff.Before), bytes.Clone(diff.After)}, path: path, directory: directory.directory, parentIdentity: directory.identity, before: bytes.Clone(before), after: bytes.Clone(after), present: present, mode: mode}
	proposal.ID = Hash([]byte(proposal.ExpectedHash + Hash(after) + path + setupSeal(proposal)))
	proposal.seal = setupSeal(proposal)
	return proposal, nil
}

func (directory *configDirectory) names() (lock, recovery string) {
	key := Hash([]byte(directory.name))[7:31]
	return ".bfb-" + key + ".lock", ".bfb-" + key + ".recovery"
}

func (directory *configDirectory) lock() (*os.File, error) {
	name, _ := directory.names()
	file, err := directory.root.OpenFile(name, os.O_CREATE|os.O_RDWR|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0600)
	if err != nil {
		return nil, Failure("provider_path_unsafe")
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		_ = file.Close()
		return nil, Failure("provider_path_unsafe")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) {
		_ = file.Close()
		return nil, Failure("provider_path_unsafe")
	}
	if unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB) != nil {
		_ = file.Close()
		return nil, Failure("provider_setup_conflict")
	}
	return file, nil
}

func (directory *configDirectory) sync() error {
	file, err := directory.root.Open(".")
	if err != nil {
		return Failure("provider_setup_failed")
	}
	defer file.Close()
	if file.Sync() != nil {
		return Failure("provider_setup_failed")
	}
	return nil
}

func (directory *configDirectory) writeExclusive(name string, data []byte, mode os.FileMode) error {
	file, err := directory.root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return Failure("provider_setup_conflict")
	}
	defer file.Close()
	if _, err := file.Write(data); err != nil {
		return Failure("provider_setup_failed")
	}
	if file.Chmod(mode) != nil || file.Sync() != nil {
		return Failure("provider_setup_failed")
	}
	if file.Close() != nil {
		return Failure("provider_setup_failed")
	}
	return nil
}

func (directory *configDirectory) stagedName() string {
	_, recovery := directory.names()
	return recovery + ".staged"
}

func (directory *configDirectory) replace(data []byte, mode os.FileMode, expectedHash string, expectedPresent bool) error {
	temp := directory.stagedName()
	if err := directory.writeExclusive(temp, data, mode); err != nil {
		return err
	}
	if err := directory.sync(); err != nil {
		return err
	}
	if expectedPresent {
		root, err := directory.root.Open(".")
		if err != nil {
			return Failure("provider_setup_failed")
		}
		err = exchangeConfig(int(root.Fd()), temp, directory.name)
		_ = root.Close()
		if err != nil {
			return Failure("provider_setup_conflict")
		}
		if err := directory.makeStagedPrivate(); err != nil {
			return err
		}
		// Atomic exchange retains even an edit made after the last hash check.
		displaced, present, _, err := directory.read(temp)
		if err != nil || configHash(displaced, present) != expectedHash {
			_ = directory.sync()
			return Failure("provider_setup_conflict")
		}
	} else {
		// Hard-link publication has create-if-absent semantics; it never replaces a raced file.
		if err := directory.root.Link(temp, directory.name); err != nil {
			return Failure("provider_setup_conflict")
		}
	}
	if directory.root.Remove(temp) != nil {
		return Failure("provider_setup_failed")
	}
	return directory.sync()
}

func (directory *configDirectory) makeStagedPrivate() error {
	file, err := directory.root.OpenFile(directory.stagedName(), os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return Failure("provider_setup_conflict")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return Failure("provider_setup_conflict")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) || file.Chmod(0600) != nil {
		return Failure("provider_setup_conflict")
	}
	return nil
}

func (directory *configDirectory) restoreAbsence(expectedHash string) error {
	root, err := directory.root.Open(".")
	if err != nil {
		return Failure("provider_setup_failed")
	}
	err = moveConfig(int(root.Fd()), directory.name, directory.stagedName())
	_ = root.Close()
	if err != nil {
		return Failure("provider_setup_conflict")
	}
	if err := directory.makeStagedPrivate(); err != nil {
		return err
	}
	displaced, present, _, err := directory.read(directory.stagedName())
	if err != nil || configHash(displaced, present) != expectedHash {
		_ = directory.sync()
		return Failure("provider_setup_conflict")
	}
	if directory.root.Remove(directory.stagedName()) != nil {
		return Failure("provider_setup_failed")
	}
	return directory.sync()
}

type recoveryRecord struct {
	Version    int         `json:"version"`
	Target     string      `json:"target"`
	Before     []byte      `json:"before"`
	BeforeHash string      `json:"before_hash"`
	AfterHash  string      `json:"after_hash"`
	Present    bool        `json:"present"`
	Mode       os.FileMode `json:"mode"`
}

func (directory *configDirectory) recover() error {
	_, name := directory.names()
	data, present, mode, err := directory.read(name)
	if err != nil || (present && mode&0077 != 0) {
		return Failure("provider_setup_conflict")
	}
	if !present {
		return nil
	}
	var recovery recoveryRecord
	if decodeJSON(data, &recovery, 4*1024*1024) != nil || recovery.Version != 1 || recovery.Target != directory.name || len(recovery.Before) > maxConfigBytes || !hashPattern.MatchString(recovery.AfterHash) || recovery.BeforeHash != configHash(recovery.Before, recovery.Present) || recovery.Mode&^0777 != 0 || recovery.Mode&0022 != 0 {
		return Failure("provider_setup_conflict")
	}
	current, exists, _, err := directory.read(directory.name)
	if err != nil {
		return err
	}
	hash := configHash(current, exists)
	staged, stagedPresent, _, stagedErr := directory.read(directory.stagedName())
	if stagedErr != nil {
		return Failure("provider_setup_conflict")
	}
	if stagedPresent {
		stagedHash := configHash(staged, true)
		if (stagedHash != recovery.BeforeHash && stagedHash != recovery.AfterHash) || (hash != recovery.BeforeHash && hash != recovery.AfterHash) {
			// A non-cooperating writer's displaced file remains private and recoverable.
			return Failure("provider_setup_conflict")
		}
		if directory.root.Remove(directory.stagedName()) != nil {
			return Failure("provider_setup_failed")
		}
	}
	if hash != recovery.BeforeHash {
		if hash != recovery.AfterHash {
			return Failure("provider_setup_conflict")
		}
		if recovery.Present {
			if err := directory.replace(recovery.Before, recovery.Mode, recovery.AfterHash, true); err != nil {
				return err
			}
		} else if err := directory.restoreAbsence(recovery.AfterHash); err != nil {
			return err
		}
	}
	if directory.root.Remove(name) != nil {
		return Failure("provider_setup_failed")
	}
	return directory.sync()
}

func ApplySetup(ctx context.Context, proposal SetupProposal, approval SetupApproval, doctor Doctor) error {
	if !approval.Approved || doctor == nil || proposal.seal == "" || proposal.seal != setupSeal(proposal) || approval.ProposalID != proposal.ID || approval.ExpectedHash != proposal.ExpectedHash {
		return Failure("provider_setup_denied")
	}
	directory, err := openConfigDirectory(proposal.path)
	if err != nil {
		return err
	}
	defer directory.root.Close()
	if directory.directory != proposal.directory || directory.identity != proposal.parentIdentity {
		return Failure("provider_setup_conflict")
	}
	lock, err := directory.lock()
	if err != nil {
		return err
	}
	defer lock.Close()
	_, recoveryName := directory.names()
	if _, present, _, err := directory.read(recoveryName); err != nil || present {
		return Failure("provider_setup_conflict")
	}
	if _, present, _, err := directory.read(directory.stagedName()); err != nil || present {
		return Failure("provider_setup_conflict")
	}
	current, present, mode, err := directory.read(directory.name)
	if err != nil {
		return err
	}
	if configHash(current, present) != proposal.ExpectedHash || mode != proposal.mode {
		return Failure("provider_setup_conflict")
	}
	if ctx.Err() != nil {
		return Failure("provider_setup_failed")
	}
	recovery := recoveryRecord{Version: 1, Target: directory.name, Before: proposal.before, BeforeHash: proposal.ExpectedHash, AfterHash: configHash(proposal.after, true), Present: proposal.present, Mode: proposal.mode}
	raw, _ := json.Marshal(recovery)
	if err := directory.writeExclusive(recoveryName, raw, 0600); err != nil {
		return err
	}
	if err := directory.sync(); err != nil {
		return err
	}
	// Cooperating setup writers hold this inode lock. Recheck after journaling for other edits.
	current, present, mode, err = directory.read(directory.name)
	if err != nil || configHash(current, present) != proposal.ExpectedHash || mode != proposal.mode {
		return Failure("provider_setup_conflict")
	}
	if err := directory.replace(proposal.after, proposal.mode, proposal.ExpectedHash, proposal.present); err != nil {
		return err
	}
	doctorErr := doctor(ctx)
	if doctorErr != nil || ctx.Err() != nil {
		if err := directory.recover(); err != nil {
			return err
		}
		return Failure("provider_setup_failed")
	}
	current, present, _, err = directory.read(directory.name)
	if err != nil || configHash(current, present) != recovery.AfterHash {
		return Failure("provider_setup_conflict")
	}
	if directory.root.Remove(recoveryName) != nil {
		return Failure("provider_setup_failed")
	}
	return directory.sync()
}

// RecoverSetup is an explicit local recovery action; concurrent external edits remain untouched.
func RecoverSetup(path string) error {
	directory, err := openConfigDirectory(path)
	if err != nil {
		return err
	}
	defer directory.root.Close()
	lock, err := directory.lock()
	if err != nil {
		return err
	}
	defer lock.Close()
	return directory.recover()
}

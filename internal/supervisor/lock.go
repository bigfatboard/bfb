// ABOUTME: Fences managed launches with physical-worktree locks and authenticated durable recovery markers.
// ABOUTME: Retains occupancy after crashes and permits release only from verified process absence.

package supervisor

import (
	"encoding/json"
	"errors"
	"os"
	"regexp"
	"strings"
	"sync"
	"syscall"

	"github.com/qdis/bfb/internal/daemon"
	"golang.org/x/sys/unix"
)

var executionID = regexp.MustCompile(`^[0-7][0-9A-HJKMNP-TV-Z]{25}$`)
var worktreeDigest = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
var processStart = regexp.MustCompile(`^[0-9]{1,20}:[0-9]{1,20}$`)

type LockBinding struct {
	ExecutionID          string `json:"execution_id"`
	AssignmentGeneration int64  `json:"assignment_generation"`
	FencingGeneration    int64  `json:"fencing_generation"`
	PhysicalWorktreeHash string `json:"physical_worktree_hash"`
}

func (binding LockBinding) valid() bool {
	return executionID.MatchString(binding.ExecutionID) && binding.AssignmentGeneration > 0 && binding.AssignmentGeneration <= 9007199254740991 && binding.FencingGeneration > 0 && binding.FencingGeneration <= 9007199254740991 && worktreeDigest.MatchString(binding.PhysicalWorktreeHash)
}

type LockRecord struct {
	Version       int         `json:"version"`
	LockID        string      `json:"lock_id"`
	Binding       LockBinding `json:"binding"`
	Owner         Process     `json:"owner"`
	Group         *Group      `json:"group"`
	State         string      `json:"state"`
	RecoveryLocal bool        `json:"recovery_local"`
	SpawnPending  bool        `json:"spawn_pending,omitempty"`
}

func validRecordedProcess(process Process) bool {
	return process.PID > 1 && process.PID <= 2147483647 && process.ParentPID >= 0 && process.ParentPID <= 2147483647 && process.GroupID > 0 && process.GroupID <= 2147483647 && process.UID == os.Getuid() && processStart.MatchString(process.StartIdentity)
}

func (record LockRecord) valid() bool {
	if record.Version != 1 || !executionID.MatchString(record.LockID) || !record.Binding.valid() || !validRecordedProcess(record.Owner) {
		return false
	}
	if record.State != "reserved" && record.State != "owned" && record.State != "containment_unknown" && record.State != "released" {
		return false
	}
	if record.RecoveryLocal && record.State != "released" {
		return false
	}
	group := record.Group
	if record.SpawnPending && (record.State != "reserved" || group != nil || record.RecoveryLocal) {
		return false
	}
	if group == nil {
		return record.State != "owned"
	}
	if record.State == "reserved" || !validRecordedProcess(group.Leader) || group.Leader.GroupID != group.Leader.PID || group.Leader.ParentPID != record.Owner.PID || len(group.Observed) == 0 || len(group.Observed) > maxObservedProcesses || !group.Leader.Same(group.Observed[group.Leader.PID]) {
		return false
	}
	for pid, process := range group.Observed {
		if pid != process.PID || !validRecordedProcess(process) {
			return false
		}
	}
	return (!group.HadEscape && !group.Incomplete || group.Unknown) && (!group.Unknown || record.State == "containment_unknown" || record.State == "released")
}

type LockStore struct{ directory *privateDirectory }

func lockName(hash, suffix string) string { return strings.TrimPrefix(hash, "sha256:") + suffix }

func OpenLockStore(path string) (*LockStore, error) {
	directory, err := openPrivateDirectory(path)
	if err != nil {
		return nil, err
	}
	return &LockStore{directory: directory}, nil
}

func (store *LockStore) Close() error { return store.directory.file.Close() }

type WorktreeLock struct {
	mu     sync.Mutex
	store  *LockStore
	file   *os.File
	record LockRecord
	closed bool
	failed bool
}

func (store *LockStore) fence(hash string, create bool) (*os.File, error) {
	if !worktreeDigest.MatchString(hash) {
		return nil, failure("invalid_request")
	}
	flags := unix.O_RDONLY
	if create {
		flags = unix.O_CREAT | unix.O_RDWR
	}
	file, err := store.directory.open(lockName(hash, ".lock"), flags)
	if err != nil {
		return nil, failure("unsafe_state")
	}
	if err = unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = file.Close()
		if errors.Is(err, unix.EWOULDBLOCK) {
			return nil, failure("checkout_occupied")
		}
		return nil, failure("containment_unknown")
	}
	return file, nil
}

func (store *LockStore) read(hash string) (LockRecord, error) {
	var record LockRecord
	err := store.directory.read(lockName(hash, ".json"), &record)
	if err != nil {
		return LockRecord{}, err
	}
	if !record.valid() || record.Binding.PhysicalWorktreeHash != hash {
		return LockRecord{}, failure("containment_unknown")
	}
	return record, nil
}

func (store *LockStore) Acquire(binding LockBinding) (*WorktreeLock, error) {
	if !binding.valid() {
		return nil, failure("invalid_request")
	}
	file, err := store.fence(binding.PhysicalWorktreeHash, true)
	if err != nil {
		return nil, err
	}
	failed := true
	defer func() {
		if failed {
			_ = file.Close()
		}
	}()
	previous, err := store.read(binding.PhysicalWorktreeHash)
	if err != nil && !errors.Is(err, unix.ENOENT) {
		return nil, failure("containment_unknown")
	}
	if err == nil && (previous.State != "released" || previous.Binding.ExecutionID == binding.ExecutionID) {
		return nil, failure("containment_unknown")
	}
	info, statErr := file.Stat()
	if statErr != nil || (errors.Is(err, unix.ENOENT) && info.Size() != 0) {
		return nil, failure("containment_unknown")
	}
	if info.Size() == 0 {
		if _, err = file.WriteAt([]byte("bfb-local-worktree-lock/1\n"), 0); err != nil || file.Sync() != nil || store.directory.file.Sync() != nil {
			return nil, failure("storage_failed")
		}
	}
	table, err := InspectProcesses()
	owner := table[os.Getpid()]
	if err != nil || !validRecordedProcess(owner) || owner.Zombie {
		return nil, failure("containment_unknown")
	}
	lock := &WorktreeLock{store: store, file: file, record: LockRecord{Version: 1, LockID: daemon.NewRequestID(), Binding: binding, Owner: owner, State: "reserved"}}
	if err = lock.persist(); err != nil {
		return nil, err
	}
	failed = false
	return lock, nil
}

func (lock *WorktreeLock) persist() error {
	if !lock.record.valid() || lock.store.directory.write(lockName(lock.record.Binding.PhysicalWorktreeHash, ".json"), lock.record) != nil {
		lock.failed = true
		return failure("containment_unknown")
	}
	return nil
}

// beginSpawn closes the crash window before process creation. If the owner
// disappears before recording a native child identity, absence is unprovable;
// recovery must not reinterpret the old reservation as never having spawned.
func (lock *WorktreeLock) beginSpawn() error {
	lock.mu.Lock()
	defer lock.mu.Unlock()
	if err := lock.check(); err != nil {
		return err
	}
	if lock.record.State != "reserved" || lock.record.Group != nil || lock.record.SpawnPending {
		return failure("containment_unknown")
	}
	lock.record.SpawnPending = true
	return lock.persist()
}

// cancelSpawn is used only after exec.Cmd.Start proves process creation failed.
// A successful Start, lost inspection, EOF or child exit cannot clear this flag.
func (lock *WorktreeLock) cancelSpawn() error {
	lock.mu.Lock()
	defer lock.mu.Unlock()
	if err := lock.check(); err != nil {
		return err
	}
	if lock.record.State != "reserved" || lock.record.Group != nil || !lock.record.SpawnPending {
		return failure("containment_unknown")
	}
	lock.record.SpawnPending = false
	return lock.persist()
}

// check is called under the owner mutex before every effect. The stable inode
// must still be present, and only the process which acquired it may act.
func (lock *WorktreeLock) check() error {
	if lock.closed || lock.failed || lock.record.Owner.PID != os.Getpid() {
		return failure("containment_unknown")
	}
	current, err := lock.store.directory.open(lockName(lock.record.Binding.PhysicalWorktreeHash, ".lock"), unix.O_RDONLY)
	if err != nil {
		return failure("containment_unknown")
	}
	defer current.Close()
	expected, firstErr := lock.file.Stat()
	actual, secondErr := current.Stat()
	if firstErr != nil || secondErr != nil || !os.SameFile(expected, actual) {
		return failure("containment_unknown")
	}
	durable, err := lock.store.read(lock.record.Binding.PhysicalWorktreeHash)
	want, _ := json.Marshal(lock.record)
	got, _ := json.Marshal(durable)
	if err != nil || string(want) != string(got) {
		return failure("containment_unknown")
	}
	return nil
}

// Attach records the direct child's reserved PID before its private execution
// gate may open. The child must not exec a provider before this durable write.
func (lock *WorktreeLock) Attach(leader Process) error {
	lock.mu.Lock()
	defer lock.mu.Unlock()
	if err := lock.check(); err != nil {
		return err
	}
	if lock.record.State != "reserved" || lock.record.Group != nil {
		return failure("containment_unknown")
	}
	table, err := InspectProcesses()
	current := table[leader.PID]
	if err != nil || !leader.Same(current) || current.ParentPID != os.Getpid() || !lock.record.Owner.Same(table[os.Getpid()]) {
		return failure("containment_unknown")
	}
	group, err := NewGroup(current)
	if err != nil {
		return err
	}
	lock.record.Group, lock.record.State, lock.record.SpawnPending = group, "owned", false
	return lock.persist()
}

func (lock *WorktreeLock) observe() (GroupObservation, error) {
	if err := lock.check(); err != nil {
		lock.failed = true
		return GroupObservation{State: "containment_unknown"}, err
	}
	if lock.record.Group == nil {
		if lock.record.SpawnPending {
			return GroupObservation{State: "containment_unknown"}, failure("containment_unknown")
		}
		return GroupObservation{State: "never_started"}, nil
	}
	table, err := InspectProcesses()
	if err != nil {
		lock.record.State, lock.record.Group.Unknown = "containment_unknown", true
		_ = lock.persist()
		return GroupObservation{State: "containment_unknown"}, failure("containment_unknown")
	}
	before, _ := json.Marshal(lock.record.Group)
	observation := lock.record.Group.Observe(table)
	if observation.State == "containment_unknown" {
		lock.record.State = "containment_unknown"
	}
	after, _ := json.Marshal(lock.record.Group)
	if string(before) != string(after) {
		if err = lock.persist(); err != nil {
			return GroupObservation{State: "containment_unknown"}, err
		}
	}
	return observation, nil
}

func (lock *WorktreeLock) Observe() (GroupObservation, error) {
	lock.mu.Lock()
	defer lock.mu.Unlock()
	return lock.observe()
}

func (lock *WorktreeLock) Signal(signal syscall.Signal) error {
	lock.mu.Lock()
	defer lock.mu.Unlock()
	observation, err := lock.observe()
	if err != nil || observation.State != "live" {
		return failure("containment_unknown")
	}
	err = lock.record.Group.Signal(signal)
	if lock.record.Group.Unknown {
		lock.record.State = "containment_unknown"
	}
	if persistErr := lock.persist(); persistErr != nil {
		return persistErr
	}
	return err
}

func (lock *WorktreeLock) Release() error {
	lock.mu.Lock()
	defer lock.mu.Unlock()
	observation, err := lock.observe()
	if err != nil || (observation.State != "gone" && observation.State != "never_started") || lock.record.State == "containment_unknown" {
		return failure("containment_unknown")
	}
	lock.record.State = "released"
	if err = lock.persist(); err != nil {
		return err
	}
	lock.closed = true
	return lock.file.Close()
}

// Close is abandonment, not release. The persistent marker still blocks another
// launch, including after the kernel drops this descriptor on process death.
func (lock *WorktreeLock) Close() error {
	lock.mu.Lock()
	defer lock.mu.Unlock()
	if lock.closed {
		return nil
	}
	lock.closed = true
	return lock.file.Close()
}

// recoverLocal is invoked only by explicit local inspection, never a cloud
// command or timer. The caller must supply the daemon's retained history too.
func (store *LockStore) recoverLocal(binding LockBinding, observed *Group) error {
	if !binding.valid() {
		return failure("invalid_request")
	}
	file, err := store.fence(binding.PhysicalWorktreeHash, false)
	if err != nil {
		return err
	}
	defer file.Close()
	record, err := store.read(binding.PhysicalWorktreeHash)
	if err != nil || record.Binding != binding || record.SpawnPending {
		return failure("containment_unknown")
	}
	record.Group = mergeGroups(record.Group, observed)
	if record.Group != nil && record.Group.Unknown && record.State != "released" {
		record.State = "containment_unknown"
	}
	if !record.valid() {
		return failure("containment_unknown")
	}
	table, err := InspectProcesses()
	owner, present := table[record.Owner.PID]
	if err != nil || (present && !owner.Zombie) || (record.Group != nil && !record.Group.ProveGone(table)) {
		return failure("containment_unknown")
	}
	record.State, record.RecoveryLocal = "released", true
	return store.directory.write(lockName(binding.PhysicalWorktreeHash, ".json"), record)
}

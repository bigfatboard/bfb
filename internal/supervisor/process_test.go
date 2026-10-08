// ABOUTME: Proves conservative descendant, PID-reuse and explicit absence rules with bounded process tables.
// ABOUTME: Keeps sticky containment uncertainty separate from local recovery's proof of absence.

package supervisor

import (
	"os"
	"os/exec"
	"syscall"
	"testing"
)

func fixtureProcess(pid, parent, group int) Process {
	return Process{PID: pid, ParentPID: parent, GroupID: group, UID: os.Getuid(), StartIdentity: "1000:42"}
}

func killFixture(t *testing.T, process Process) {
	t.Helper()
	table, err := InspectProcesses()
	if err != nil || !process.Same(table[process.PID]) {
		t.Fatal("fixture process identity changed")
	}
	if err := syscall.Kill(process.PID, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
}

func TestGroupTracksSurvivingChildren(t *testing.T) {
	leader := fixtureProcess(1201, 1200, 1201)
	group, err := NewGroup(leader)
	if err != nil {
		t.Fatal(err)
	}
	child := fixtureProcess(1202, 1201, 1201)
	table := ProcessTable{1201: leader, 1202: child}
	if result := group.Observe(table); result.State != "live" || len(result.Live) != 2 {
		t.Fatal(result)
	}
	delete(table, 1201)
	child.ParentPID = 1
	table[1202] = child
	if result := group.Observe(table); result.State != "live" || len(result.Live) != 1 || group.ProveGone(table) {
		t.Fatal(result)
	}
	delete(table, 1202)
	if result := group.Observe(table); result.State != "gone" || !group.ProveGone(table) {
		t.Fatal(result)
	}
}

func TestGroupAdoptsNeverObservedOrphanStartedAfterLeader(t *testing.T) {
	leader := fixtureProcess(1201, 1200, 1201)
	group, err := NewGroup(leader)
	if err != nil {
		t.Fatal(err)
	}
	// The intermediate parent backgrounded a child and exited before any
	// inspection saw either of them. The orphan is reparented to PID 1, so
	// the ancestry walk cannot root it; the kernel still proves descent
	// because it shares the owned group and started after the leader.
	orphan := fixtureProcess(1203, 1, 1201)
	orphan.StartIdentity = "1000:43"
	table := ProcessTable{1201: leader, 1203: orphan}
	if result := group.Observe(table); result.State != "live" || group.Unknown || len(result.Live) != 2 {
		t.Fatal("reparented descendant poisoned containment", result, group.Unknown)
	}
	if group.Observed[orphan.PID] != orphan {
		t.Fatal("adopted orphan not retained for absence proof")
	}
	// A child of the adopted orphan roots through it in the same observation.
	grandchild := fixtureProcess(1204, 1203, 1201)
	grandchild.StartIdentity = "1000:44"
	table[grandchild.PID] = grandchild
	if result := group.Observe(table); result.State != "live" || group.Unknown || len(result.Live) != 3 {
		t.Fatal("descendant of adopted orphan poisoned containment", result, group.Unknown)
	}
	delete(table, orphan.PID)
	delete(table, grandchild.PID)
	delete(table, leader.PID)
	if result := group.Observe(table); result.State != "gone" || !group.ProveGone(table) {
		t.Fatal("adopted orphans blocked whole-group absence", result)
	}
}

func TestGroupKeepsUnprovableMembersUnknown(t *testing.T) {
	for _, fault := range []string{"older_start", "malformed_start", "live_parent_elsewhere", "zombie_parent"} {
		t.Run(fault, func(t *testing.T) {
			leader := fixtureProcess(1201, 1200, 1201)
			group, _ := NewGroup(leader)
			table := ProcessTable{1201: leader}
			member := fixtureProcess(1202, 1, 1201)
			switch fault {
			case "older_start":
				// A recycled group ID whose member predates the leader.
				member.StartIdentity = "999:99"
			case "malformed_start":
				member.StartIdentity = "not-a-start"
			case "live_parent_elsewhere":
				// A live process that joined the owned group: its parent
				// is alive outside the group, so descent is unprovable.
				member.ParentPID = 1209
				member.StartIdentity = "1000:43"
				table[1209] = fixtureProcess(1209, 1, 1209)
			case "zombie_parent":
				member.ParentPID = 1209
				member.StartIdentity = "1000:43"
				parent := fixtureProcess(1209, 1201, 1201)
				parent.Zombie = true
				table[1209] = parent
			}
			table[member.PID] = member
			if result := group.Observe(table); result.State != "containment_unknown" || group.ProveGone(table) {
				t.Fatal("unprovable member was adopted as owned", result)
			}
		})
	}
}

func TestGroupUncertaintySurvivesOrdinaryAbsence(t *testing.T) {
	for _, fault := range []string{"escape", "reuse", "unknown_group", "bound"} {
		t.Run(fault, func(t *testing.T) {
			leader := fixtureProcess(1201, 1200, 1201)
			group, _ := NewGroup(leader)
			table := ProcessTable{1201: leader}
			switch fault {
			case "escape":
				table[1202] = fixtureProcess(1202, 1201, 1202)
			case "reuse":
				leader.StartIdentity = "1001:43"
				table[1201] = leader
			case "unknown_group":
				table[1202] = fixtureProcess(1202, 1, 1201)
			case "bound":
				for pid := 1202; pid < 1202+maxObservedProcesses; pid++ {
					table[pid] = fixtureProcess(pid, 1201, 1201)
				}
			}
			if result := group.Observe(table); result.State != "containment_unknown" || group.ProveGone(table) {
				t.Fatal(result)
			}
			if result := group.Observe(ProcessTable{}); result.State != "containment_unknown" || group.ProveGone(ProcessTable{}) != (fault != "bound") {
				t.Fatal(result)
			}
		})
	}
}

func TestKernelProcessIdentity(t *testing.T) {
	table, err := InspectProcesses()
	if err != nil {
		t.Fatal(err)
	}
	self := table[os.Getpid()]
	if self.PID != os.Getpid() || self.UID != os.Getuid() || self.StartIdentity == "" || self.Zombie {
		t.Fatal("kernel identity missing")
	}
	again, err := InspectProcesses()
	if err != nil || !self.Same(again[self.PID]) {
		t.Fatal("kernel identity changed")
	}
}

func TestSignalCannotUseAReusedPIDIdentity(t *testing.T) {
	command := exec.Command("/bin/sleep", "20")
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = command.Process.Kill(); _ = command.Wait() }()
	table, err := InspectProcesses()
	if err != nil {
		t.Fatal(err)
	}
	leader := table[command.Process.Pid]
	group, err := NewGroup(leader)
	if err != nil {
		t.Fatal(err)
	}
	group.Leader.StartIdentity = "1:1"
	// The retained record is internally consistent. Only a fresh kernel read
	// can discover that this PID now has another start identity.
	group.Observed[leader.PID] = group.Leader
	if group.Signal(syscall.SIGTERM) == nil {
		t.Fatal("reused PID authorized a signal")
	}
	table, err = InspectProcesses()
	if err != nil || !leader.Same(table[leader.PID]) || table[leader.PID].Zombie {
		t.Fatal("wrong identity signalled the child")
	}
	group, _ = NewGroup(leader)
	if group.Signal(syscall.SIGUSR1) == nil {
		t.Fatal("arbitrary signal accepted")
	}
	if err := group.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
}

func TestSignalRechecksLocalPermissionAfterNativeOwnership(t *testing.T) {
	leader := ownedGateTestChild(t)
	group, err := NewGroup(leader)
	if err != nil {
		t.Fatal(err)
	}
	checks := 0
	err = group.signal(syscall.SIGTERM, func() error {
		checks++
		return failure("expired_intent")
	})
	assertFailure(t, err, "expired_intent")
	table, err := InspectProcesses()
	if err != nil || checks != 1 || !leader.Same(table[leader.PID]) || table[leader.PID].Zombie || group.Unknown {
		t.Fatal("expired permission signalled or poisoned owned group", err)
	}
	group.Leader.StartIdentity = "1:1"
	if err := group.signal(syscall.SIGTERM, func() error { checks++; return nil }); err == nil || checks != 1 {
		t.Fatal("permission callback bypassed native identity")
	}
}

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

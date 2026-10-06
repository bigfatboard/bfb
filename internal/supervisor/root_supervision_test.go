// ABOUTME: Proves the separation between live-root authority and unproven detached-family lifetime.
// ABOUTME: Retains conservative identity failures and never turns root absence into automatic release.

package supervisor

import (
	"testing"

	"github.com/qdis/bfb/internal/provider"
)

func rootFixtureGroup(t *testing.T) *Group {
	t.Helper()
	group, err := NewGroup(fixtureProcess(1201, 1200, 1201))
	if err != nil {
		t.Fatal(err)
	}
	group.SupervisionMode = provider.RootSupervision
	return group
}

func TestRootSupervisionObservesDetachedLifetimeWithoutGrantingClosure(t *testing.T) {
	group := rootFixtureGroup(t)
	detached := fixtureProcess(1202, 1201, 1202)
	table := ProcessTable{1201: group.Leader, 1202: detached}
	if observed := group.Observe(table); observed.State != "live" || group.Unknown || group.HadEscape || len(group.Observed) != 2 {
		t.Fatalf("verified detached ancestry closed root authority: %+v %+v", observed, group)
	}
	delete(table, group.Leader.PID)
	if observed := group.Observe(table); observed.State != "root_ended" || group.ProveGone(table) {
		t.Fatalf("detached survivor did not revoke root authority: %+v", observed)
	}
	if group.ProveGone(ProcessTable{}) {
		t.Fatal("empty polling snapshot became whole-family absence proof")
	}
}

func TestRootSupervisionRejectsIdentityAndAncestryAmbiguity(t *testing.T) {
	for _, fault := range []string{"pid_reuse", "changed_group", "reparented", "overflow", "unproved_member", "invalid_mode"} {
		t.Run(fault, func(t *testing.T) {
			group := rootFixtureGroup(t)
			child := fixtureProcess(1202, 1201, 1202)
			table := ProcessTable{1201: group.Leader, 1202: child}
			group.Observe(table)
			switch fault {
			case "pid_reuse":
				child.StartIdentity = "1001:42"
				table[child.PID] = child
			case "changed_group":
				child.GroupID = 1203
				table[child.PID] = child
			case "reparented":
				child.ParentPID = 9999 // Not ordinary orphaning after parent absence.
				table[child.PID] = child
			case "overflow":
				for pid := 1203; pid < 1203+maxObservedProcesses; pid++ {
					table[pid] = fixtureProcess(pid, 1201, pid)
				}
			case "unproved_member":
				table[1203] = fixtureProcess(1203, 1, 1201)
			case "invalid_mode":
				group.SupervisionMode = "arbitrary"
			}
			if got := group.Observe(table); got.State != "containment_unknown" || !group.Unknown || group.ProveGone(ProcessTable{}) {
				t.Fatalf("ambiguous root authority survived: %+v %+v", got, group)
			}
		})
	}
}

func TestRootSupervisionRetainsProvedDetachedOrphanAfterIntermediateExit(t *testing.T) {
	group := rootFixtureGroup(t)
	parent := fixtureProcess(1202, group.Leader.PID, 1202)
	child := fixtureProcess(1203, parent.PID, parent.GroupID)
	table := ProcessTable{group.Leader.PID: group.Leader, parent.PID: parent, child.PID: child}
	if got := group.Observe(table); got.State != "live" {
		t.Fatal(got)
	}
	delete(table, parent.PID)
	child.ParentPID = 1
	table[child.PID] = child
	if got := group.Observe(table); got.State != "live" || group.Unknown || group.Observed[child.PID].StartIdentity != child.StartIdentity {
		t.Fatal("ordinary orphaning discarded proved lifetime identity", got, group)
	}
	if group.ProveGone(ProcessTable{}) {
		t.Fatal("retained orphaning granted family closure")
	}
}

func TestRootSupervisionCannotUpgradeStrictHistoryOrChangeSpawnedMode(t *testing.T) {
	root := rootFixtureGroup(t)
	strict := *root
	strict.SupervisionMode = ""
	if merged := mergeGroups(&strict, root); !merged.Unknown || !merged.Incomplete || merged.SupervisionMode != "" {
		t.Fatal("root mode upgraded an existing strict execution", merged)
	}
	lock, err := fixtureLockStore(t).Acquire(fixtureBinding())
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := lock.configureSupervision(provider.RootSupervision); err != nil {
		t.Fatal(err)
	}
	assertFailure(t, lock.Release(), "containment_unknown")
	if err := lock.beginSpawn(); err != nil {
		t.Fatal(err)
	}
	assertFailure(t, lock.configureSupervision(""), "containment_unknown")
	assertFailure(t, lock.configureSupervision(provider.RootSupervision), "containment_unknown")
}

// ABOUTME: Tests live-root MCP ancestry and the conservative local history projection.
// ABOUTME: Rejects missing, changed and malformed identity without reviving sticky executions.

package localmcp

import (
	"context"
	"testing"
)

func TestRootPeerAncestryRequiresFreshExactRootChain(t *testing.T) {
	for _, fault := range []string{"none", "root_reuse", "foreign_uid", "detached_group", "missing", "orphan", "cycle", "changed_during_recheck", "overflow"} {
		t.Run(fault, func(t *testing.T) {
			assignment := AssignmentRecord{ProviderPID: 1201, ProviderStart: "1:1", OwnedGroupID: 1201, RootSupervision: true}
			caller := PeerFacts{PID: 1203, ParentPID: 1202, UID: 501, GroupID: 1201, StartIdentity: "1:3"}
			table := map[int]PeerFacts{
				1201: {PID: 1201, ParentPID: 1200, UID: 501, GroupID: 1201, StartIdentity: "1:1"},
				1202: {PID: 1202, ParentPID: 1201, UID: 501, GroupID: 1201, StartIdentity: "1:2"},
				1203: caller,
			}
			parent := table[1202]
			switch fault {
			case "root_reuse":
				root := table[1201]
				root.StartIdentity = "2:1"
				table[1201] = root
			case "foreign_uid":
				parent.UID++
			case "detached_group":
				parent.GroupID = 1202
			case "missing":
				delete(table, 1201)
			case "orphan":
				parent.ParentPID = 1
			case "cycle":
				parent.ParentPID = caller.PID
			case "overflow":
				parent.ParentPID = 2000
				for pid := 2000; pid < 2300; pid++ {
					table[pid] = PeerFacts{PID: pid, ParentPID: pid + 1, UID: 501, GroupID: 1201, StartIdentity: "1:4"}
				}
			}
			table[1202] = parent
			reads := map[int]int{}
			inspect := func(pid int) (PeerFacts, error) {
				reads[pid]++
				if fault == "changed_during_recheck" && pid == 1202 && reads[pid] == 2 {
					parent.ParentPID = 1
					table[pid] = parent
				}
				process, exists := table[pid]
				if !exists {
					return PeerFacts{}, fail("peer_denied")
				}
				return process, nil
			}
			if got := rootPeerAncestry(caller, assignment, inspect); got != (fault == "none") {
				t.Fatal("root ancestry mismatch", fault, got)
			}
		})
	}
}

func TestRootSupervisionHistoryProjectionDoesNotEraseUncertainty(t *testing.T) {
	db := assignmentTestDB(t)
	group := `{"pid":4242,"parent_pid":100,"group_id":4242,"uid":501,"start_identity":"1:1"}`
	if _, err := db.Exec(`INSERT INTO local_execution_assignments VALUES ('running','correlation','w','p','t','r','runner','checkout',NULL,?,'e',1)`, group); err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		mode  string
		flags string
		live  bool
	}{
		{`"supervision_mode":"root"`, `"uncertain":false`, true},
		{`"supervision_mode":"root"`, `"uncertain":true`, false},
		{`"supervision_mode":"root","unknown":true`, `"uncertain":false`, false},
		{`"supervision_mode":"root","had_escape":true`, `"uncertain":false`, false},
		{`"supervision_mode":"root","incomplete":true`, `"uncertain":false`, false},
		{`"supervision_mode":null`, `"uncertain":false`, false},
		{`"supervision_mode":"arbitrary"`, `"uncertain":false`, false},
		{`"supervision_mode":"root","Supervision_Mode":""`, `"uncertain":false`, false},
	} {
		history := `{` + row.flags + `,"group":{"leader":` + group + `,` + row.mode + `}}`
		if _, err := db.Exec("INSERT OR REPLACE INTO execution_native_history VALUES ('e',?)", history); err != nil {
			t.Fatal(err)
		}
		record, err := (DaemonAssignments{DB: db}).Lookup(context.Background(), "e", 1)
		if err != nil || record.Active != row.live || row.live && !record.RootSupervision {
			t.Fatal("root mode cleared denial or lost identity", history, record, err)
		}
	}
}

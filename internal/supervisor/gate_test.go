// ABOUTME: Rejects malformed, stale and confused private execution permits and unbounded pipe messages.
// ABOUTME: Exercises EOF and read deadlines on real pipes without granting a provider execution.

package supervisor

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestGatePermitBindsOneChildAndShortFreshDeadline(t *testing.T) {
	_, wire, _, _ := fixtureAssignmentFiles(t)
	now := time.Now()
	wire.Claim.Specification.ExpiresAt = localTimestamp(now.Add(time.Minute))
	child := Process{PID: 3456, ParentPID: int(wire.Supervisor.Pid), UID: os.Getuid(), GroupID: 3456, StartIdentity: "123:456"}
	nonce, _ := newIntentID()
	ready := gateReady{Version: 1, IntentID: wire.TerminalIntentId, Nonce: nonce}
	permit := gatePermit{Ready: ready, Child: child, LockID: "01K00000000000000000000001", AuthorizedAt: localTimestamp(now.Add(-time.Second)), ExpiresAt: localTimestamp(now.Add(time.Second))}
	if !permit.valid(ready, child, wire, now) {
		t.Fatal("valid permit rejected")
	}
	for _, fault := range []string{"intent", "nonce", "version", "pid", "parent", "start", "uid", "group", "zombie", "lock", "future", "expired", "extended", "launch_expired", "past_launch"} {
		t.Run(fault, func(t *testing.T) {
			changed, assignment := permit, wire
			switch fault {
			case "intent":
				changed.Ready.IntentID, _ = newIntentID()
			case "nonce":
				changed.Ready.Nonce, _ = newIntentID()
			case "version":
				changed.Ready.Version++
			case "pid":
				changed.Child.PID++
			case "parent":
				changed.Child.ParentPID++
			case "start":
				changed.Child.StartIdentity = "999:0"
			case "uid":
				changed.Child.UID++
			case "group":
				changed.Child.GroupID++
			case "zombie":
				changed.Child.Zombie = true
			case "lock":
				changed.LockID = "not-a-lock"
			case "future":
				changed.AuthorizedAt = localTimestamp(now.Add(time.Second))
			case "expired":
				changed.ExpiresAt = localTimestamp(now)
			case "extended":
				changed.ExpiresAt = localTimestamp(now.Add(6 * time.Second))
			case "launch_expired":
				assignment.Claim.Specification.ExpiresAt = localTimestamp(now)
			case "past_launch":
				assignment.Claim.Specification.ExpiresAt = localTimestamp(now.Add(time.Millisecond))
			}
			if changed.valid(ready, child, assignment, now) {
				t.Fatal("invalid permit accepted")
			}
		})
	}
}

func TestGateRequiresBoundedSingleFrameAndEOF(t *testing.T) {
	for _, payload := range []string{"", "{", `{"version":1,"intent_id":"x","nonce":"y","argv":["forbidden"]}`, `{"version":1,"version":2}`, `{} {}`, strings.Repeat("x", gateMessageLimit+1)} {
		reader, writer, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan struct{})
		go func() { defer close(done); _, _ = writer.Write([]byte(payload)); _ = writer.Close() }()
		var ready gateReady
		if readGate(reader, &ready, time.Now().Add(time.Second)) == nil {
			t.Fatal("invalid frame accepted")
		}
		_ = reader.Close()
		<-done
	}
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	_, _ = writer.Write([]byte(`{"version":1,"intent_id":"x","nonce":"y"}`))
	started := time.Now()
	var ready gateReady
	if readGate(reader, &ready, started.Add(30*time.Millisecond)) == nil || time.Since(started) > time.Second {
		t.Fatal("unclosed gate ignored its deadline")
	}
}

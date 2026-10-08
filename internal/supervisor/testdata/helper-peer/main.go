// ABOUTME: Exercises signed helper authentication through actual kernel-identified Unix socket peers.
// ABOUTME: Keeps synthetic alternate builds and process controls outside the production CLI.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"reflect"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/runner"
	"github.com/qdis/bfb/internal/supervisor"
)

var variant = "expected"

type receipt struct {
	Accepted        bool   `json:"accepted"`
	Code            string `json:"code"`
	PeerMatches     bool   `json:"peer_matches"`
	DuplicateStable bool   `json:"duplicate_stable"`
	Variant         string `json:"variant"`
}

func main() {
	if len(os.Args) < 3 {
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	paths, err := daemon.StatePaths(os.Args[2])
	if err != nil {
		panic(err)
	}
	if (os.Args[1] == "recover-client" || os.Args[1] == "verified-recover-client") && len(os.Args) == 4 {
		var callErr error
		if os.Args[1] == "verified-recover-client" {
			callErr = supervisor.RecoverExecution(ctx, paths, os.Args[3])
		} else {
			_, callErr = daemon.Call(ctx, paths, "execution.recover", map[string]any{"terminal_intent_id": os.Args[3]})
		}
		value := receipt{Accepted: callErr == nil, Variant: variant}
		if callErr != nil {
			value.Code = daemon.AsFailure(callErr).Code
		}
		_ = json.NewEncoder(os.Stdout).Encode(value)
		return
	}
	if (os.Args[1] == "client" || os.Args[1] == "verified-client") && len(os.Args) == 4 {
		var assignment generated.LocalExecutionAssignment
		var callErr error
		if os.Args[1] == "verified-client" {
			assignment, callErr = supervisor.RegisterHelper(ctx, paths, os.Args[3])
		} else {
			response, err := daemon.Call(ctx, paths, "execution.register", map[string]any{"terminal_intent_id": os.Args[3]})
			callErr = err
			if err == nil {
				data, _ := json.Marshal(response.Payload["execution_assignment"])
				callErr = json.Unmarshal(data, &assignment)
			}
		}
		value := receipt{Accepted: callErr == nil, Variant: variant}
		if callErr == nil {
			value.PeerMatches = assignment.Supervisor.Pid == int64(os.Getpid())
			again, err := supervisor.RegisterHelper(ctx, paths, os.Args[3])
			value.DuplicateStable = err == nil && reflect.DeepEqual(assignment, again)
		} else {
			value.Code = daemon.AsFailure(callErr).Code
		}
		_ = json.NewEncoder(os.Stdout).Encode(value)
		return
	}
	if os.Args[1] != "serve" || len(os.Args) != 9 {
		os.Exit(2)
	}
	registry := daemon.NewRegistry()
	err = supervisor.RegisterRPC(registry, supervisor.NewService(supervisor.ServiceOptions{}))
	if err != nil {
		panic(err)
	}
	server, err := daemon.Start(ctx, paths, registry)
	if err != nil {
		panic(err)
	}
	defer server.Close()
	data, err := os.ReadFile("protocol/fixtures/v1/valid/launch-claim-result.c09-synthetic.json")
	var claim generated.LaunchClaimResult
	if err != nil || json.Unmarshal(data, &claim) != nil {
		panic("synthetic claim unavailable")
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	claim.Assignment.CreatedAt = now.Format(time.RFC3339Nano)
	claim.Specification.ExpiresAt = now.Add(2 * time.Minute).Format(time.RFC3339Nano)
	claim.LeaseExpiresAt = now.Add(45 * time.Second).Format(time.RFC3339Nano)
	claim.Specification.ConfigSnapshotHash = "sha256:b8bb44429b23a19fa2e772020d1741738332e954a0eed297a06ac56a2dbcf480"
	intents := supervisor.NewIntentStore(server.Store.DB)
	err = intents.Accept(ctx, runner.Enrollment{WorkspaceID: claim.Assignment.WorkspaceId, RunnerID: claim.Assignment.RunnerId}, runner.CommandReference{ID: claim.Specification.LaunchId, Kind: "launch", ExpiresAt: claim.Specification.ExpiresAt}, now)
	if err != nil {
		panic(err)
	}
	command, err := intents.Command(ctx, claim.Assignment.RunnerId, claim.Specification.LaunchId)
	if err != nil {
		panic(err)
	}
	assignment, err := intents.Issue(ctx, command, claim, provider.Hash(nil), now)
	if err != nil {
		panic(err)
	}
	if offered, err := intents.Offer(ctx, assignment.IntentID); err != nil || !offered {
		panic("synthetic intent not offered")
	}
	for index, executable := range os.Args[3:] {
		mode := "client"
		if index == 0 {
			mode = "verified-client"
		}
		data, err := exec.CommandContext(ctx, executable, mode, paths.Root, assignment.IntentID).Output()
		if err != nil {
			panic("synthetic helper could not reach its authenticated response")
		}
		var value receipt
		if json.Unmarshal(data, &value) != nil {
			panic("synthetic receipt invalid")
		}
		if index == 0 {
			if !value.Accepted || !value.PeerMatches || !value.DuplicateStable {
				panic("exact signed helper was rejected")
			}
		} else if index == 1 {
			if value.Accepted || value.Code != "execution_intent_consumed" {
				panic("another exact helper took over a consumed intent")
			}
		} else if value.Accepted || value.Code != "peer_denied" {
			panic("untrusted helper was accepted")
		}
		mode = "recover-client"
		if index == 0 {
			mode = "verified-recover-client"
		}
		data, err = exec.CommandContext(ctx, executable, mode, paths.Root, assignment.IntentID).Output()
		if err != nil || json.Unmarshal(data, &value) != nil {
			panic("synthetic recovery client did not reach its authenticated response")
		}
		wantCode := "peer_denied"
		if index < 2 {
			// A fresh matching helper may request inspection, but the missing
			// native marker cannot become evidence of absence or be initialized.
			wantCode = "containment_unknown"
		}
		if value.Accepted || value.Code != wantCode {
			panic("local recovery bypassed signed-peer or native-proof requirements")
		}
	}
	fmt.Println("L05_SIGNED_HELPER_OK mutual exact-build authentication; registration committed once; same-process retry stable; takeover, other build, identifier, relaxed and ad-hoc signatures rejected; local recovery requires matching helper and existing native proof")
}

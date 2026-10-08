// ABOUTME: Proves explicit result submission and protected recovery through the compiled MCP and CLI.
// ABOUTME: Uses signed native ownership, genuine trusted hooks and real Worker/D1 without provider turns.

//go:build darwin && cgo

package agentwork

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"golang.org/x/sys/unix"
)

type nativeResultFixture struct {
	ctx               context.Context
	workDB            *sql.DB
	server            *httptest.Server
	paths             daemon.Paths
	ids               func() map[string]string
	snapshot          func() string
	call              func(string, string, map[string]any) (map[string]any, string)
	submitCLI         func([]string) (map[string]any, int)
	post              func(string, any, bool) map[string]json.RawMessage
	restart           func(string)
	restartDaemon     func()
	stopMCP           func()
	freshScope        func(bool)
	hook              func(string)
	wait              func(string, func() bool)
	postflightRelease func(string)
	unlock            func()
	outage            *atomic.Bool
	proofOutage       *atomic.Bool
	outageOnLoss      *atomic.Bool
	loseReply         *atomic.Pointer[string]
	businessRequests  *atomic.Int64
	confirmations     *atomic.Int64
	replayResponses   *atomic.Int64
}

type nativeResultWork struct {
	key, state, effect, request, capture, fingerprint string
	dispatched                                        sql.NullInt64
	reason, outcome                                   sql.NullString
}

func runNativeResults(t *testing.T, fixture nativeResultFixture) {
	t.Helper()
	observe := func() map[string]json.RawMessage {
		return fixture.post("/__a03/result-observe", map[string]string{"execution": fixture.ids()["execution"]}, false)
	}
	rows := func(observation map[string]json.RawMessage, key string) []map[string]any {
		t.Helper()
		var result []map[string]any
		if json.Unmarshal(observation[key], &result) != nil {
			t.Fatal("bounded canonical result observation missing", key)
		}
		return result
	}
	workRow := func(requestID string) nativeResultWork {
		t.Helper()
		var row nativeResultWork
		if err := fixture.workDB.QueryRow(`SELECT i.operation_key,d.state,d.effect,i.request_json,i.capture_json,i.fingerprint,d.ever_dispatched_ns,d.reason_code,d.outcome_json
FROM work_intents i JOIN work_delivery d USING(operation_key)
WHERE json_extract(i.request_json,'$.reference.request_id')=? AND json_extract(i.request_json,'$.reference.run_execution_id')=?`, requestID, fixture.ids()["execution"]).Scan(&row.key, &row.state, &row.effect, &row.request, &row.capture, &row.fingerprint, &row.dispatched, &row.reason, &row.outcome); err != nil {
			t.Fatal("durable native result disposition", requestID, err)
		}
		return row
	}
	noIntent := func(requestID string) {
		t.Helper()
		var count int
		if err := fixture.workDB.QueryRow(`SELECT COUNT(*) FROM work_intents
WHERE json_extract(request_json,'$.reference.request_id')=? AND json_extract(request_json,'$.reference.run_execution_id')=?`, requestID, fixture.ids()["execution"]).Scan(&count); err != nil || count != 0 {
			t.Fatal("denied result created a signed intent", count, err)
		}
	}
	pause := func(duration time.Duration) {
		t.Helper()
		timer := time.NewTimer(duration)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-fixture.ctx.Done():
			t.Fatal("result fixture deadline reached")
		}
	}
	lease := func() map[string]any {
		t.Helper()
		var result map[string]any
		if json.Unmarshal(observe()["lease"], &result) != nil || result == nil {
			t.Fatal("canonical result lease missing")
		}
		return result
	}
	lockHeld := func() {
		t.Helper()
		name := filepath.Join(fixture.paths.Root, "worktree-locks", strings.TrimPrefix(fixture.ids()["physical"], "sha256:")+".lock")
		fd, err := unix.Open(name, unix.O_RDONLY|unix.O_NOFOLLOW, 0)
		if err != nil {
			t.Fatal("real native lock disappeared", err)
		}
		defer unix.Close(fd)
		if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != unix.EWOULDBLOCK && err != unix.EAGAIN {
			t.Fatal("result transition released the live native lock", err)
		}
	}
	committed := func(result map[string]any, code string, version int) map[string]any {
		t.Helper()
		encoded, err := json.Marshal(result)
		if code != "" || err != nil || !protocol.DecodeWireDocument("agent-result-result", encoded).OK || result["version"] != float64(version) || result["result_state"] != "submitted" || result["task_state"] != "review" {
			t.Fatal("compiled result lacked the exact bounded committed projection", code)
		}
		origin, ok := result["origin"].(map[string]any)
		if !ok || origin["run_id"] != fixture.ids()["run"] || origin["run_execution_id"] != fixture.ids()["execution"] || origin["assignment_generation"] != float64(1) || origin["provider_session_id"] == nil {
			t.Fatal("result projection lost canonical agent origin")
		}
		for _, field := range []string{"summary", "limitations", "evidence_refs", "submission", "binding", "capture"} {
			if _, present := result[field]; present {
				t.Fatal("private result content reached a committed projection", field)
			}
		}
		return result
	}
	receipt := func(result map[string]any, code, requestID, state, certainty string, reason any) {
		t.Helper()
		encoded, err := json.Marshal(result)
		if code != "" || err != nil || !protocol.DecodeWireDocument("agent-result-receipt", encoded).OK || result["tool"] != "bfb_submit_result" || result["request_id"] != requestID || result["delivery_state"] != state || result["effect_certainty"] != certainty || result["reason_code"] != reason {
			t.Fatal("untruthful bounded result receipt", code, state, certainty, reason)
		}
	}
	cliArgs := func(id string, params map[string]any) []string {
		t.Helper()
		args := []string{"--request-id", id, "--summary", params["summary"].(string)}
		for _, field := range []string{"limitations", "git_branch", "git_commit"} {
			if value, present := params[field]; present {
				args = append(args, "--"+strings.ReplaceAll(field, "_", "-"), value.(string))
			}
		}
		if value, present := params["git_dirty"]; present {
			args = append(args, "--git-dirty="+fmt.Sprint(value))
		}
		if value, present := params["evidence_refs"]; present {
			encoded, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			args = append(args, "--evidence-refs-json", string(encoded))
		}
		return args
	}
	cli := func(id string, params map[string]any) (map[string]any, string, int) {
		result, status := fixture.submitCLI(cliArgs(id, params))
		if failure, ok := result["error"].(map[string]any); ok {
			code, _ := failure["code"].(string)
			if code == "" || status == 0 {
				t.Fatal("CLI error lacked a stable failure exit")
			}
			return nil, code, status
		}
		return result, "", status
	}
	submit := func(id string, params map[string]any) map[string]any {
		t.Helper()
		result, code := fixture.call("bfb_submit_result", id, params)
		if code != "" {
			t.Fatal("compiled MCP result submit failed", code)
		}
		return result
	}
	browser := nativeAttentionFixture{ctx: fixture.ctx, server: fixture.server}
	review := func(projection map[string]any, decision, id string, reviewer bool) nativeAttentionBrowserResult {
		return browser.browser("/api/v1/workspaces/"+fixture.ids()["workspace"]+"/runs/"+fixture.ids()["run"]+"/review", map[string]any{
			"request_id": id, "decision": decision, "submission_id": projection["submission_id"],
			"expected_run_version": projection["run_version"], "expected_task_version": projection["task_version"],
			"comment": "A03_PRIVATE_REVIEW_CANARY",
		}, reviewer)
	}
	checkReview := func(result nativeAttentionBrowserResult, status int) {
		t.Helper()
		if result.err != nil || result.status != status {
			t.Fatal("real human result review route failed", result.status, result.err)
		}
	}
	privacy := func() {
		t.Helper()
		var receiptPrivacy struct {
			Total           int `json:"total"`
			PrivatePayloads int `json:"private_payloads"`
		}
		if json.Unmarshal(observe()["receiptPrivacy"], &receiptPrivacy) != nil || receiptPrivacy.Total == 0 || receiptPrivacy.PrivatePayloads != 0 {
			t.Fatal("private result or human review content entered event/audit/outbox receipts")
		}
		stored, err := fixture.workDB.Query("SELECT outcome_json FROM work_delivery WHERE outcome_json IS NOT NULL")
		if err != nil {
			t.Fatal(err)
		}
		defer stored.Close()
		for stored.Next() {
			var outcome string
			if stored.Scan(&outcome) != nil || strings.Contains(outcome, "A03_PRIVATE_") {
				t.Fatal("private result body entered the daemon outcome journal")
			}
		}
		if err := stored.Err(); err != nil {
			t.Fatal(err)
		}
	}
	configure := func(allow bool, age string) {
		setting := "deny"
		if allow {
			setting = "allow"
		}
		fixture.post("/__a03/configure", map[string]string{"offline": "allow", "result_offline": setting, "result_age": age}, false)
	}
	prime := func(label string) {
		t.Helper()
		previous := fixture.confirmations.Load()
		fixture.hook("synthetic-result-" + label)
		if _, code := fixture.call("bfb_add_comment", "native-result-prime-"+label, map[string]any{"body": "Synthetic verified task-work confirmation"}); code != "" {
			t.Fatal("genuine result-prime trigger failed", code)
		}
		fixture.wait("genuine optional result confirmation "+label, func() bool { return fixture.confirmations.Load() > previous })
	}
	// Cloud response observation deliberately does not assert daemon publication.
	// Only an actual signed pending receipt establishes admission. Retries while
	// postflight publishes keep the same identity and must leave no intent on denial.
	offlineCapture := func(id string, params map[string]any, useCLI bool) map[string]any {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for {
			var result map[string]any
			var code string
			if useCLI {
				var status int
				result, code, status = cli(id, params)
				if code == "" && status != 0 {
					t.Fatal("CLI durable pending disposition had a failure exit", status)
				}
			} else {
				result, code = fixture.call("bfb_submit_result", id, params)
			}
			if code == "" {
				receipt(result, code, id, "pending_sync", "not_attempted", nil)
				return result
			}
			if code != "offline_rejected" && code != "capture_unavailable" || time.Now().After(deadline) {
				t.Fatal("matching result proof did not enable genuine outage capture", code)
			}
			noIntent(id)
			pause(25 * time.Millisecond)
		}
	}
	assertOriginal := func(before, after nativeResultWork) {
		t.Helper()
		if before.key != after.key || before.capture != after.capture || before.request != after.request || before.fingerprint != after.fingerprint {
			t.Fatal("result recovery replaced the original signed identity or bytes")
		}
	}

	// Explicit interactive input is required, and a fresh CLI is independently
	// kernel authenticated rather than borrowing an in-memory MCP capability.
	params := map[string]any{
		"summary":     "A03_PRIVATE_SUMMARY_CANARY_" + strings.Repeat("<", 2048-len("A03_PRIVATE_SUMMARY_CANARY_")),
		"limitations": "A03_PRIVATE_LIMITATIONS_CANARY",
		"evidence_refs": []any{
			map[string]any{"kind": "comment", "ref": "A03_PRIVATE_EVIDENCE_CANARY_\u2028<>&", "version": "1"},
			map[string]any{"kind": "external", "ref": "literal\\u2028", "hash": "sha256:" + strings.Repeat("a", 64)},
		},
		"git_branch": "synthetic/result", "git_commit": strings.Repeat("a", 40), "git_dirty": false,
	}
	if _, code := fixture.call("bfb_submit_result", "native-result-before-binding", params); code != "session_not_bound" {
		t.Fatal("unbound result mutation was accepted", code)
	}
	noIntent("native-result-before-binding")
	fixture.hook("synthetic-result-online")
	first := committed(submit("native-result-online", params), "", 1)
	firstObservation := observe()
	firstRows := rows(firstObservation, "submissions")
	if len(firstRows) != 1 || firstRows[0]["summary"] != params["summary"] || firstRows[0]["submitted_by_kind"] != "agent_run" || firstRows[0]["submitted_by_id"] != fixture.ids()["run"] || firstRows[0]["config_snapshot_id"] != fixture.snapshot() {
		t.Fatal("compiled result did not create exactly one snapshot-bound agent submission")
	}
	lockHeld()
	if repeated := committed(submit("native-result-online", params), "", 1); !reflect.DeepEqual(first, repeated) {
		t.Fatal("MCP retry changed the original committed projection")
	}
	fixture.restart("__restart")
	if repeated := committed(submit("native-result-online", params), "", 1); !reflect.DeepEqual(first, repeated) {
		t.Fatal("submitted-state retry failed after a new MCP host")
	}
	changed := map[string]any{"summary": "Changed synthetic input"}
	if _, code := fixture.call("bfb_submit_result", "native-result-online", changed); code != "request_conflict" {
		t.Fatal("local result identity forgot its input binding", code)
	}
	if repeated := committed(submit("native-result-online", params), "", 1); !reflect.DeepEqual(first, repeated) {
		t.Fatal("changed result retry closed the submitted-state MCP authority")
	}
	fixture.stopMCP()
	repeated, code, status := cli("native-result-online", params)
	if status != 0 || !reflect.DeepEqual(first, committed(repeated, code, 1)) {
		t.Fatal("fresh one-shot CLI could not reconcile the original submitted-state result", code, status)
	}
	if _, code, _ := cli("native-result-online", changed); code != "request_conflict" {
		t.Fatal("fresh CLI changed an existing result fingerprint", code)
	}
	checkReview(review(first, "accept", "native-result-reviewer-accept", true), 403)
	checkReview(review(first, "request_changes", "native-result-human-changes", true), 200)
	secondParams := map[string]any{"summary": "  A03_PRIVATE_RESUBMIT_CANARY \u2029 <>&  ", "limitations": "  Synthetic explicit limitations  "}
	second, code, status := cli("native-result-second", secondParams)
	if status != 0 {
		t.Fatal("fresh CLI resubmission failed", code, status)
	}
	committed(second, code, 2)
	secondRows := rows(observe(), "submissions")
	if len(secondRows) != 2 || !reflect.DeepEqual(firstRows[0], secondRows[0]) || secondRows[1]["summary"] != strings.TrimSpace(secondParams["summary"].(string)) || secondRows[1]["limitations"] != strings.TrimSpace(secondParams["limitations"].(string)) {
		t.Fatal("changes/resubmit cycle rewrote immutable history or normalized the wrong input")
	}
	if stored := workRow("native-result-second"); !strings.Contains(stored.request, secondParams["summary"].(string)) {
		t.Fatal("daemon fingerprint storage lost original business whitespace or Unicode")
	}
	beforeAccept := lease()
	checkReview(review(second, "accept", "native-result-human-accept", false), 200)
	if after := lease(); !reflect.DeepEqual(beforeAccept, after) {
		t.Fatal("human acceptance altered the live checkout lease")
	}
	lockHeld()
	terminal, code, status := cli("native-result-second", secondParams)
	receipt(terminal, code, "native-result-second", "delivery_blocked", "confirmed", "capability_closed")
	if status == 0 {
		t.Fatal("terminal result receipt had a successful CLI exit")
	}
	privacy()
	t.Log("A03_NATIVE_EXPLICIT_REVIEW_CYCLE_COMPLETE")

	// A result permission cannot be obtained from an A01-only confirmation.
	configure(true, "300")
	fixture.proofOutage.Store(true)
	fixture.freshScope(true)
	fixture.hook("synthetic-result-task-only")
	fixture.stopMCP()
	fixture.outage.Store(true)
	if _, code, _ := cli("native-result-no-prior-proof", map[string]any{"summary": "Synthetic denied unconfirmed result"}); code != "offline_rejected" {
		t.Fatal("fresh CLI fabricated a result confirmation while offline", code)
	}
	noIntent("native-result-no-prior-proof")
	fixture.outage.Store(false)
	fixture.restart("__start")
	if _, code := fixture.call("bfb_add_comment", "native-result-task-only-prime", map[string]any{"body": "Synthetic A01-only proof"}); code != "" {
		t.Fatal("A01-only proof fixture failed", code)
	}
	fixture.stopMCP()
	fixture.outage.Store(true)
	if _, code, _ := cli("native-result-missing-proof", map[string]any{"summary": "Synthetic denied missing result proof"}); code != "offline_rejected" {
		t.Fatal("A01-only confirmation substituted for result authority", code)
	}
	noIntent("native-result-missing-proof")
	fixture.outage.Store(false)
	fixture.proofOutage.Store(false)
	fixture.freshScope(true)
	fixture.hook("synthetic-result-fresh-cli-online")
	fixture.stopMCP()
	freshCLIParams := map[string]any{"summary": "A03_PRIVATE_FRESH_CLI_CANARY"}
	freshCLI, code, status := cli("native-result-fresh-cli-online", freshCLIParams)
	if status != 0 {
		t.Fatal("fresh CLI without MCP activation could not bind and submit online", code, status)
	}
	committed(freshCLI, code, 1)
	if len(rows(observe(), "submissions")) != 1 {
		t.Fatal("fresh CLI online binding created duplicate business state")
	}
	// A known committed submission invalidates new-capture eligibility even
	// before the client receives a fresh can_submit=false cloud confirmation.
	fixture.outage.Store(true)
	if _, code, _ := cli("native-result-known-submitted-cli", freshCLIParams); code != "offline_rejected" {
		t.Fatal("known submission admitted a new offline CLI result", code)
	}
	noIntent("native-result-known-submitted-cli")
	fixture.restart("__start")
	if _, code := fixture.call("bfb_submit_result", "native-result-known-submitted-mcp", freshCLIParams); code != "offline_rejected" {
		t.Fatal("known submission admitted a new offline MCP result", code)
	}
	noIntent("native-result-known-submitted-mcp")
	if len(rows(observe(), "submissions")) != 1 {
		t.Fatal("known submitted state allocated another immutable result version")
	}
	fixture.outage.Store(false)
	if repeated := committed(submit("native-result-fresh-cli-online", freshCLIParams), "", 1); !reflect.DeepEqual(freshCLI, repeated) {
		t.Fatal("known submission invalidation blocked the original committed retry")
	}
	fixture.freshScope(true)
	prime("expired-proof")
	fixture.stopMCP()
	fixture.outage.Store(true)
	pause(46 * time.Second)
	if _, code, _ := cli("native-result-expired-proof", map[string]any{"summary": "Synthetic denied expired confirmation"}); code != "offline_rejected" {
		t.Fatal("expired result proof granted fresh CLI offline capture", code)
	}
	noIntent("native-result-expired-proof")
	if current := lease(); current["state"] != "live" || current["execution_id"] != fixture.ids()["execution"] || current["fencing_generation"] != float64(1) || current["observation_sequence"].(float64) < 1 {
		t.Fatal("expired-proof denial did not isolate a normally renewed live lease")
	}
	fixture.outage.Store(false)
	fixture.restart("__start")

	// An online-only possibly-applied result remains explicit-retry-only, even
	// across client/daemon exit or a later genuine policy enablement.
	configure(false, "0")
	fixture.freshScope(true)
	fixture.hook("synthetic-result-online-only")
	action := "result-submit"
	fixture.loseReply.Store(&action)
	onlineParams := map[string]any{"summary": "A03_PRIVATE_ONLINE_LOSS_CANARY"}
	lost, code := fixture.call("bfb_submit_result", "native-result-online-loss", onlineParams)
	receipt(lost, code, "native-result-online-loss", "delivery_blocked", "possibly_applied", "work_unavailable")
	unknown := workRow("native-result-online-loss")
	if unknown.effect != "unknown" || !unknown.dispatched.Valid || len(rows(observe(), "submissions")) != 1 {
		t.Fatal("lost real result response erased its possible committed effect")
	}
	fixture.stopMCP()
	sends := fixture.businessRequests.Load()
	fixture.restartDaemon()
	pause(4200 * time.Millisecond)
	assertOriginal(unknown, workRow("native-result-online-loss"))
	if fixture.businessRequests.Load() != sends || workRow("native-result-online-loss").outcome.Valid {
		t.Fatal("online-only result autonomously reconciled after daemon restart")
	}
	configure(true, "300")
	pause(4200 * time.Millisecond)
	if fixture.businessRequests.Load() != sends || workRow("native-result-online-loss").outcome.Valid {
		t.Fatal("later result permission upgraded an online-only intent")
	}
	// The historical snapshot changed by policy enablement, so this old intent
	// must retain uncertainty rather than becoming a new online submission.
	blocked, code, status := cli("native-result-online-loss", onlineParams)
	receipt(blocked, code, "native-result-online-loss", "delivery_blocked", "possibly_applied", "policy_rejected")
	if status == 0 || len(rows(observe(), "submissions")) != 1 {
		t.Fatal("changed policy delivered or duplicated an uncertain historical result")
	}
	t.Log("A03_NATIVE_ONLINE_ONLY_COMPLETE")

	var priorOfflineKey string
	for _, transport := range []string{"mcp", "cli"} {
		fixture.freshScope(true)
		prime("offline-" + transport)
		fixture.outage.Store(true)
		pendingParams := map[string]any{"summary": "  A03_PRIVATE_OFFLINE_" + transport + "_CANARY \u2028 <>&  "}
		id := "native-result-offline-same-id"
		if transport == "cli" {
			fixture.stopMCP()
		}
		pending := offlineCapture(id, pendingParams, transport == "cli")
		admitted := workRow(id)
		if admitted.state != "open" || admitted.effect != "never_sent" || admitted.dispatched.Valid || admitted.outcome.Valid || pending["operation_key"] != admitted.key || pending["admission_mode"] != "offline_admitted" || priorOfflineKey == admitted.key || len(rows(observe(), "submissions")) != 0 {
			t.Fatal("protected result outage admission lacked original scoped never-sent intent", transport)
		}
		priorOfflineKey = admitted.key
		if transport == "mcp" {
			fixture.stopMCP()
		}
		beforeRenewal := lease()
		fixture.restartDaemon()
		fixture.wait("ordinary same-owner result lease renewal "+transport, func() bool {
			current := lease()
			return current["execution_id"] == beforeRenewal["execution_id"] && current["fencing_generation"] == beforeRenewal["fencing_generation"] && current["state"] == "live" && current["observation_sequence"].(float64) > beforeRenewal["observation_sequence"].(float64) && current["expires_at"].(string) > beforeRenewal["expires_at"].(string)
		})
		assertOriginal(admitted, workRow(id))
		if _, code, _ := cli(id+"-new-after-restart", pendingParams); code != "offline_rejected" {
			t.Fatal("daemon restart reconstructed new result-capture permission", code)
		}
		noIntent(id + "-new-after-restart")
		stillPending, code, status := cli(id, pendingParams)
		receipt(stillPending, code, id, "pending_sync", "not_attempted", nil)
		if status != 0 {
			t.Fatal("fresh CLI could not retain the existing original signed outage intent", status)
		}
		replays := fixture.replayResponses.Load()
		fixture.outage.Store(false)
		fixture.wait("daemon-only result replay "+transport, func() bool { return workRow(id).state == "applied" })
		applied := workRow(id)
		assertOriginal(admitted, applied)
		if applied.effect != "applied" || !applied.dispatched.Valid || !applied.outcome.Valid || fixture.replayResponses.Load() <= replays || len(rows(observe(), "submissions")) != 1 {
			t.Fatal("protected result recovery did not commit one actual Worker effect", transport)
		}
		recovered, code, status := cli(id, pendingParams)
		if status != 0 {
			t.Fatal("explicit original result retry failed after autonomous submission", transport, code, status)
		}
		committed(recovered, code, 1)
		if len(rows(observe(), "submissions")) != 1 {
			t.Fatal("explicit result retry allocated another version", transport)
		}
		privacy()
		fixture.restart("__start")
	}
	t.Log("A03_NATIVE_OFFLINE_MCP_CLI_RESTART_COMPLETE")

	// Fault only the real acknowledgement UPDATE after a canonical D1 commit.
	fixture.freshScope(true)
	fixture.hook("synthetic-result-ack")
	if _, err := fixture.workDB.Exec(`CREATE TRIGGER a03_fixture_ack_loss BEFORE UPDATE OF state ON work_delivery
WHEN NEW.state='applied' AND OLD.state='open' AND (SELECT json_extract(request_json,'$.reference.request_id') FROM work_intents WHERE operation_key=NEW.operation_key)='native-result-ack-loss'
BEGIN SELECT RAISE(ABORT,'synthetic result acknowledgment failure'); END`); err != nil {
		t.Fatal(err)
	}
	ackParams := map[string]any{"summary": "A03_PRIVATE_ACK_LOSS_CANARY"}
	if _, code := fixture.call("bfb_submit_result", "native-result-ack-loss", ackParams); code != "storage_failed" {
		t.Fatal("failed result acknowledgement looked successful", code)
	}
	ackBefore := workRow("native-result-ack-loss")
	if ackBefore.effect != "unknown" || !ackBefore.dispatched.Valid || ackBefore.outcome.Valid || len(rows(observe(), "submissions")) != 1 {
		t.Fatal("result acknowledgement failure lost its committed-effect ambiguity")
	}
	fixture.stopMCP()
	if _, err := fixture.workDB.Exec("DROP TRIGGER a03_fixture_ack_loss"); err != nil {
		t.Fatal(err)
	}
	fixture.restartDaemon()
	fixture.wait("submitted-state result acknowledgement recovery", func() bool { return workRow("native-result-ack-loss").state == "applied" })
	assertOriginal(ackBefore, workRow("native-result-ack-loss"))
	if len(rows(observe(), "submissions")) != 1 {
		t.Fatal("result acknowledgement recovery created a second immutable version")
	}
	fixture.restart("__start")

	// The signed intent exists before marker failure, but no business send may.
	fixture.freshScope(true)
	prime("marker")
	fixture.outage.Store(true)
	markerParams := map[string]any{"summary": "A03_PRIVATE_MARKER_CANARY"}
	offlineCapture("native-result-marker-loss", markerParams, false)
	markerBefore := workRow("native-result-marker-loss")
	if _, err := fixture.workDB.Exec(`CREATE TRIGGER a03_fixture_marker_loss BEFORE UPDATE OF ever_dispatched_ns ON work_delivery
WHEN OLD.ever_dispatched_ns IS NULL AND NEW.ever_dispatched_ns IS NOT NULL AND (SELECT json_extract(request_json,'$.reference.request_id') FROM work_intents WHERE operation_key=NEW.operation_key)='native-result-marker-loss'
BEGIN SELECT RAISE(ABORT,'synthetic result dispatch failure'); END`); err != nil {
		t.Fatal(err)
	}
	sends = fixture.businessRequests.Load()
	fixture.outage.Store(false)
	if _, code := fixture.call("bfb_submit_result", "native-result-marker-loss", markerParams); code != "storage_failed" {
		t.Fatal("failed result dispatch marker looked successful", code)
	}
	markerAfter := workRow("native-result-marker-loss")
	assertOriginal(markerBefore, markerAfter)
	if markerAfter.effect != "never_sent" || markerAfter.dispatched.Valid || markerAfter.outcome.Valid || fixture.businessRequests.Load() != sends || len(rows(observe(), "submissions")) != 0 {
		t.Fatal("failed durable result marker sent business work")
	}
	fixture.stopMCP()
	if _, err := fixture.workDB.Exec("DROP TRIGGER a03_fixture_marker_loss"); err != nil {
		t.Fatal(err)
	}
	fixture.restartDaemon()
	fixture.wait("never-sent result marker recovery", func() bool { return workRow("native-result-marker-loss").state == "applied" })
	assertOriginal(markerBefore, workRow("native-result-marker-loss"))
	if len(rows(observe(), "submissions")) != 1 {
		t.Fatal("result marker recovery did not commit exactly one version")
	}
	fixture.restart("__start")
	t.Log("A03_NATIVE_DURABLE_FAULTS_COMPLETE")

	// Lost responses reconcile the original operation after its own submitted
	// transition; a current can_submit=false does not authorize another effect.
	fixture.freshScope(true)
	fixture.hook("synthetic-result-uncertain-restart")
	lossParams := map[string]any{"summary": "A03_PRIVATE_RESTART_LOSS_CANARY"}
	fixture.outageOnLoss.Store(true)
	fixture.loseReply.Store(&action)
	lost, code = fixture.call("bfb_submit_result", "native-result-lost-restart", lossParams)
	receipt(lost, code, "native-result-lost-restart", "pending_sync", "possibly_applied", nil)
	lossBefore := workRow("native-result-lost-restart")
	if lossBefore.effect != "unknown" || !lossBefore.dispatched.Valid || len(rows(observe(), "submissions")) != 1 {
		t.Fatal("real result commit/reply loss lacked durable uncertainty")
	}
	fixture.stopMCP()
	beforeRenewal := lease()
	fixture.restartDaemon()
	fixture.wait("ordinary renewal before uncertain result reconciliation", func() bool {
		current := lease()
		return current["execution_id"] == beforeRenewal["execution_id"] && current["fencing_generation"] == beforeRenewal["fencing_generation"] && current["state"] == "live" && current["observation_sequence"].(float64) > beforeRenewal["observation_sequence"].(float64) && current["expires_at"].(string) > beforeRenewal["expires_at"].(string)
	})
	fixture.outage.Store(false)
	fixture.wait("original submitted result lost-reply recovery", func() bool { return workRow("native-result-lost-restart").state == "applied" })
	assertOriginal(lossBefore, workRow("native-result-lost-restart"))
	if len(rows(observe(), "submissions")) != 1 {
		t.Fatal("submitted-state reconciliation created a new submission version")
	}
	recovered, code, status := cli("native-result-lost-restart", lossParams)
	if status != 0 {
		t.Fatal("fresh CLI lost-reply reconciliation failed", code, status)
	}
	committed(recovered, code, 1)
	fixture.restart("__start")

	// Strict expiry retains the effect of a possibly committed result and never
	// routes the expired original intent through a new online submission.
	configure(true, "3")
	fixture.freshScope(true)
	fixture.hook("synthetic-result-uncertain-expiry")
	expiryParams := map[string]any{"summary": "A03_PRIVATE_EXPIRY_CANARY"}
	fixture.outageOnLoss.Store(true)
	fixture.loseReply.Store(&action)
	expiring, code := fixture.call("bfb_submit_result", "native-result-uncertain-expiry", expiryParams)
	receipt(expiring, code, "native-result-uncertain-expiry", "pending_sync", "possibly_applied", nil)
	expiryBefore := workRow("native-result-uncertain-expiry")
	stamp, ok := expiring["intent_expires_at"].(string)
	deadline, err := time.Parse(time.RFC3339Nano, stamp)
	if !ok || err != nil {
		t.Fatal("protected result intent expiry missing")
	}
	fixture.stopMCP()
	pause(max(0, time.Until(deadline.Add(100*time.Millisecond))))
	sends = fixture.businessRequests.Load()
	fixture.outage.Store(false)
	fixture.wait("strict result intent expiry", func() bool { return workRow("native-result-uncertain-expiry").state == "blocked" })
	expiryAfter := workRow("native-result-uncertain-expiry")
	assertOriginal(expiryBefore, expiryAfter)
	if expiryAfter.effect != "unknown" || expiryAfter.reason.String != "intent_expired" || fixture.businessRequests.Load() != sends || len(rows(observe(), "submissions")) != 1 {
		t.Fatal("result expiry erased uncertainty or sent another business request")
	}
	expired, code, status := cli("native-result-uncertain-expiry", expiryParams)
	receipt(expired, code, "native-result-uncertain-expiry", "delivery_blocked", "possibly_applied", "intent_expired")
	if status == 0 {
		t.Fatal("expired result recovery returned a successful CLI exit")
	}
	configure(true, "300")
	fixture.restart("__start")

	fixture.freshScope(true)
	fixture.hook("synthetic-result-postflight")
	fixture.postflightRelease("result-submit")
	postflight, code := fixture.call("bfb_submit_result", "native-result-postflight", map[string]any{"summary": "A03_PRIVATE_POSTFLIGHT_CANARY"})
	receipt(postflight, code, "native-result-postflight", "delivery_blocked", "confirmed", "assignment_ended")
	if len(rows(observe(), "submissions")) != 1 {
		t.Fatal("postflight native denial falsely implied no committed result")
	}
	if _, code := fixture.call("bfb_submit_result", "native-result-postflight", map[string]any{"summary": "A03_PRIVATE_POSTFLIGHT_CANARY"}); code != "capability_closed" {
		t.Fatal("postflight result denial did not retain sticky closure", code)
	}
	t.Log("A03_NATIVE_UNCERTAINTY_AND_POSTFLIGHT_COMPLETE")

	// Current canonical session and native ownership can block admitted work
	// without changing its signed fence or pretending a send occurred.
	for _, closure := range []string{"session", "lock", "policy", "grant"} {
		fixture.freshScope(true)
		prime("fence-" + closure)
		id := "native-result-queued-" + closure
		pendingParams := map[string]any{"summary": "A03_PRIVATE_FENCE_" + closure + "_CANARY"}
		if closure == "grant" {
			fixture.outageOnLoss.Store(true)
			fixture.loseReply.Store(&action)
			uncertain, code := fixture.call("bfb_submit_result", id, pendingParams)
			receipt(uncertain, code, id, "pending_sync", "possibly_applied", nil)
		} else {
			fixture.outage.Store(true)
			offlineCapture(id, pendingParams, false)
		}
		before := workRow(id)
		fixture.stopMCP()
		reason := "capability_closed"
		if closure == "lock" {
			reason = "assignment_ended"
			fixture.unlock()
		} else if closure == "policy" {
			reason = "policy_rejected"
			fixture.post("/__a03/project-tighten", map[string]string{}, false)
		} else {
			if closure == "grant" {
				reason = "revoked"
			}
			fixture.post("/__a01/change", map[string]string{"execution": fixture.ids()["execution"], "kind": closure}, false)
		}
		sends = fixture.businessRequests.Load()
		fixture.outage.Store(false)
		fixture.wait("queued result current fence "+closure, func() bool { return workRow(id).state == "blocked" })
		after := workRow(id)
		assertOriginal(before, after)
		expectedEffect, expectedSubmissions, dispatched := "never_sent", 0, false
		if closure == "grant" {
			expectedEffect, expectedSubmissions, dispatched = "unknown", 1, true
		}
		if after.effect != expectedEffect || after.dispatched.Valid != dispatched || after.reason.String != reason || fixture.businessRequests.Load() != sends || len(rows(observe(), "submissions")) != expectedSubmissions {
			t.Fatal("queued result ignored its current authority or changed certainty", closure)
		}
		if closure != "grant" && closure != "lock" {
			fixture.restart("__start")
		}
		if closure == "policy" {
			configure(true, "300")
		}
	}
	privacy()
	t.Log("A03_NATIVE_PROOF_COMPLETE")
}

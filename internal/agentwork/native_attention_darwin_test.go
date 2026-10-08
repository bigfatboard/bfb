// ABOUTME: Proves online attention through compiled stdio, signed daemon and authenticated Worker/D1.
// ABOUTME: Retains real native ownership and budgets while isolating synthetic human answers and faults.

//go:build darwin && cgo

package agentwork

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
)

type nativeAttentionFixture struct {
	ctx               context.Context
	workDB            *sql.DB
	server            *httptest.Server
	ids               func() map[string]string
	call              func(string, string, map[string]any) (map[string]any, string)
	post              func(string, any, bool) map[string]json.RawMessage
	restart           func(string)
	restartDaemon     func()
	stopMCP           func()
	freshScope        func(bool)
	hook              func(string)
	outage            *atomic.Bool
	loseReply         *atomic.Pointer[string]
	businessRequests  *atomic.Int64
	reads             *atomic.Int64
	slowRead          *atomic.Bool
	postflightRelease func(string)
}

type nativeAttentionBrowserResult struct {
	status int
	body   map[string]any
	err    error
}

// Browser credentials remain in the parent test, never the provider-shaped process.
func (fixture nativeAttentionFixture) browser(path string, body any, reviewer bool) nativeAttentionBrowserResult {
	data, err := json.Marshal(body)
	if err != nil {
		return nativeAttentionBrowserResult{err: err}
	}
	request, err := http.NewRequestWithContext(fixture.ctx, "POST", fixture.server.URL+path, bytes.NewReader(data))
	if err != nil {
		return nativeAttentionBrowserResult{err: err}
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "https://bfb.channel.test")
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	cookie, csrf := "BFB_A01_TEST_COOKIE", "BFB_A01_TEST_CSRF"
	if reviewer {
		cookie, csrf = "BFB_A02_TEST_REVIEWER_COOKIE", "BFB_A02_TEST_REVIEWER_CSRF"
	}
	request.Header.Set("Cookie", os.Getenv(cookie))
	request.Header.Set("X-BFB-CSRF", os.Getenv(csrf))
	response, err := fixture.server.Client().Do(request)
	if err != nil {
		return nativeAttentionBrowserResult{err: err}
	}
	defer response.Body.Close()
	data, err = io.ReadAll(io.LimitReader(response.Body, 65_537))
	result := nativeAttentionBrowserResult{status: response.StatusCode}
	if err != nil || len(data) > 65_536 {
		result.err = fmt.Errorf("bounded browser response unavailable")
		return result
	}
	result.err = json.Unmarshal(data, &result.body)
	return result
}

func runNativeAttention(t *testing.T, fixture nativeAttentionFixture) {
	t.Helper()
	observe := func() map[string]json.RawMessage {
		t.Helper()
		return fixture.post("/__a02/attention-observe", map[string]string{"execution": fixture.ids()["execution"]}, false)
	}
	rows := func(observation map[string]json.RawMessage, key string) []map[string]any {
		t.Helper()
		var result []map[string]any
		if json.Unmarshal(observation[key], &result) != nil {
			t.Fatal("bounded attention observation missing", key)
		}
		return result
	}
	noJournal := func() {
		t.Helper()
		for _, table := range []string{"work_intents", "work_delivery"} {
			var count int
			if err := fixture.workDB.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != 0 {
				t.Fatal("attention entered the task-operation journal", table, count, err)
			}
		}
	}
	requestParams := func(question string) map[string]any {
		return map[string]any{"kind": "clarification", "question": question, "blocking": true}
	}
	request := func(id, question string) map[string]any {
		t.Helper()
		result, code := fixture.call("bfb_request_human", id, requestParams(question))
		if code != "" || result["state"] != "open" || result["required_role"] != "reviewer" || result["resource_version"] != float64(1) || result["question"] != question {
			t.Fatal("compiled attention creation failed", code)
		}
		if _, ok := result["id"].(string); !ok {
			t.Fatal("attention creation lacks canonical identity")
		}
		return result
	}
	get := func(attentionID, requestID string) map[string]any {
		t.Helper()
		result, code := fixture.call("bfb_get_attention", requestID, map[string]any{"attention_id": attentionID})
		if code != "" || result["id"] != attentionID {
			t.Fatal("compiled committed attention read failed", code)
		}
		return result
	}
	answer := func(attentionID, requestID, text string, reviewer bool) nativeAttentionBrowserResult {
		return fixture.browser("/api/v1/workspaces/"+fixture.ids()["workspace"]+"/attention/"+attentionID+"/answer", map[string]any{"request_id": requestID, "expected_version": 1, "answer": text}, reviewer)
	}
	checkBrowser := func(result nativeAttentionBrowserResult, status int) {
		t.Helper()
		if result.err != nil || result.status != status {
			t.Fatal("real attention human route failed", result.status, result.err)
		}
	}
	pause := func(duration time.Duration) {
		t.Helper()
		timer := time.NewTimer(duration)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-fixture.ctx.Done():
			t.Fatal("attention fixture deadline reached")
		}
	}

	noJournal()
	if _, code := fixture.call("bfb_get_attention", "a02-provisional-missing", map[string]any{"attention_id": daemon.NewRequestID()}); code != "not_found" {
		t.Fatal("provisional scoped read was not reachable", code)
	}
	if _, code := fixture.call("bfb_request_human", "a02-before-binding", requestParams("Synthetic denied unbound question")); code != "session_not_bound" {
		t.Fatal("unbound attention mutation succeeded", code)
	}
	if len(rows(observe(), "attention")) != 0 || len(rows(observe(), "observations")) != 0 {
		t.Fatal("unbound request created business state")
	}

	fixture.hook("synthetic-attention-session")
	question := "A02_PRIVATE_QUESTION_CANARY_" + strings.Repeat("<", 2048-len("A02_PRIVATE_QUESTION_CANARY_"))
	answerText := "A02_PRIVATE_ANSWER_CANARY_" + strings.Repeat(">", 2048-len("A02_PRIVATE_ANSWER_CANARY_"))
	created := request("a02-question-main", question)
	attentionID := created["id"].(string)
	if open := get(attentionID, "a02-current-read"); !reflect.DeepEqual(open, created) {
		t.Fatal("creation and fresh read disagree")
	}
	answered := make(chan nativeAttentionBrowserResult, 1)
	go func() {
		timer := time.NewTimer(1500 * time.Millisecond)
		defer timer.Stop()
		select {
		case <-timer.C:
			answered <- answer(attentionID, "a02-human-answer", answerText, true)
		case <-fixture.ctx.Done():
			answered <- nativeAttentionBrowserResult{err: fixture.ctx.Err()}
		}
	}()
	waited, code := fixture.call("bfb_wait_for_attention", "a02-current-wait", map[string]any{"attention_id": attentionID})
	checkBrowser(<-answered, 200)
	if code != "" || waited["status"] != "answered" {
		t.Fatal("active compiled waiter missed permitted human answer", code)
	}
	current := get(attentionID, "a02-current-read")
	if current["answer"] != answerText || current["resource_version"] != float64(2) || !reflect.DeepEqual(current, waited["attention"]) {
		t.Fatal("cached read hid answer or waiter metadata differed")
	}
	duplicate := fixture.browser("/api/v1/workspaces/"+fixture.ids()["workspace"]+"/attention/"+attentionID+"/answer", map[string]any{"request_id": "a02-duplicate-human", "expected_version": 2, "answer": "Synthetic forbidden overwrite"}, false)
	checkBrowser(duplicate, 409)
	if duplicate.body["attention"].(map[string]any)["answer"] != answerText {
		t.Fatal("duplicate answer overwrote committed human decision")
	}
	resolved := fixture.browser("/api/v1/workspaces/"+fixture.ids()["workspace"]+"/attention/"+attentionID+"/resolve", map[string]any{"request_id": "a02-human-resolve", "expected_version": 2}, true)
	checkBrowser(resolved, 200)
	resolution := get(attentionID, "a02-current-read")
	if resolution["state"] != "resolved" || resolution["resource_version"] != float64(3) || resolution["resolved_at"] == nil {
		t.Fatal("fresh repeated read hid resolution")
	}
	fixture.restartDaemon()
	fixture.restart("__restart")
	if restored := get(attentionID, "a02-current-read"); !reflect.DeepEqual(restored, resolution) {
		t.Fatal("answer was not durable across signed daemon and MCP restart")
	}
	if repeated, code := fixture.call("bfb_wait_for_attention", "a02-current-wait", map[string]any{"attention_id": attentionID}); code != "" || !reflect.DeepEqual(repeated["attention"], resolution) {
		t.Fatal("repeated wait retained a stale answered record", code)
	}
	for _, receipt := range rows(observe(), "receipts") {
		payload, _ := json.Marshal(receipt)
		if bytes.Contains(payload, []byte("A02_PRIVATE_QUESTION_CANARY")) || bytes.Contains(payload, []byte("A02_PRIVATE_ANSWER_CANARY")) {
			t.Fatal("private attention content entered event/audit/outbox receipts")
		}
	}
	credentialParams := map[string]any{"kind": "credential", "question": "Synthetic owner-only decision", "blocking": false}
	credential, code := fixture.call("bfb_request_human", "a02-owner-only", credentialParams)
	if code != "" || credential["required_role"] != "owner" {
		t.Fatal("owner-only attention kind lost role", code)
	}
	checkBrowser(answer(credential["id"].(string), "a02-reviewer-denied", "Synthetic nonapproval", true), 403)
	if get(credential["id"].(string), "a02-owner-current")["state"] != "open" {
		t.Fatal("reviewer answered owner-only attention")
	}
	t.Log("A02_NATIVE_ANSWER_DURABILITY_COMPLETE")

	// A lost real commit is recovered only by the exact explicit original request.
	lostAction := "attention-request"
	fixture.loseReply.Store(&lostAction)
	lostQuestion := "Synthetic attention committed reply loss"
	if _, code := fixture.call("bfb_request_human", "a02-lost-reply", requestParams(lostQuestion)); code != "offline_rejected" {
		t.Fatal("lost attention reply did not remain visibly uncertain", code)
	}
	lostObservation := observe()
	if len(rows(lostObservation, "attention")) != 3 || len(rows(lostObservation, "observations")) != 5 {
		t.Fatal("lost response did not commit one attention request/observation")
	}
	fixture.stopMCP()
	requestsBefore := fixture.businessRequests.Load()
	fixture.restartDaemon()
	pause(4200 * time.Millisecond)
	noJournal()
	if fixture.businessRequests.Load() != requestsBefore || string(observe()["attention"]) != string(lostObservation["attention"]) {
		t.Fatal("attention autonomously resent after MCP exit/daemon restart")
	}
	fixture.restart("__start")
	retried := request("a02-lost-reply", lostQuestion)
	if len(rows(observe(), "attention")) != 3 || len(rows(observe(), "observations")) != 5 {
		t.Fatal("explicit uncertain retry duplicated attention business state")
	}
	fixture.restart("__restart")
	if _, code := fixture.call("bfb_request_human", "a02-lost-reply", requestParams("Changed synthetic question")); code != "request_rejected" {
		t.Fatal("cloud attention identity forgot its original fingerprint", code)
	}
	if unchanged := request("a02-lost-reply", lostQuestion); unchanged["id"] != retried["id"] {
		t.Fatal("attention retry replaced original canonical identity")
	}
	noJournal()

	// Even explicit task offline permission cannot journal an attention operation.
	fixture.post("/__a01/configure", map[string]string{"offline": "allow"}, false)
	fixture.freshScope(true)
	if _, code := fixture.call("bfb_get_attention", "a02-foreign-run", map[string]any{"attention_id": attentionID}); code != "not_found" {
		t.Fatal("foreign run attention was visible to provisional read", code)
	}
	fixture.hook("synthetic-attention-offline")
	offlineCurrent := request("a02-offline-prime", "Synthetic current online attention")
	fixture.outage.Store(true)
	for tool, params := range map[string]map[string]any{
		"bfb_request_human":      requestParams("Synthetic forbidden offline attention"),
		"bfb_get_attention":      {"attention_id": offlineCurrent["id"]},
		"bfb_wait_for_attention": {"attention_id": offlineCurrent["id"]},
	} {
		if _, code := fixture.call(tool, "a02-offline-"+tool, params); code != "offline_rejected" {
			t.Fatal("attention acquired offline delivery permission", tool, code)
		}
	}
	fixture.stopMCP()
	requestsBefore = fixture.businessRequests.Load()
	fixture.restartDaemon()
	fixture.outage.Store(false)
	pause(4200 * time.Millisecond)
	if fixture.businessRequests.Load() != requestsBefore || len(rows(observe(), "attention")) != 1 {
		t.Fatal("offline attention was replayed after restart/reconnect")
	}
	noJournal()
	t.Log("A02_NATIVE_ONLINE_ONLY_COMPLETE")

	// Ordinary unanswered polling reaches the full bound. A slower private
	// response hits the existing channel timeout first and stays visibly failed.
	fixture.freshScope(true)
	fixture.hook("synthetic-attention-timeout")
	bounded := request("a02-timeout-question", "Synthetic unanswered bounded waiter")
	beforeClock := observe()["clock"]
	beforePolls := fixture.reads.Load()
	start := time.Now()
	pending, code := fixture.call("bfb_wait_for_attention", "a02-timeout-wait", map[string]any{"attention_id": bounded["id"]})
	elapsed, polls := time.Since(start), fixture.reads.Load()-beforePolls
	if code != "" || pending["status"] != "pending" || elapsed < 29*time.Second || elapsed > 32*time.Second || polls < 21 || polls > 32 {
		t.Log("bounded attention authority clocks", string(beforeClock), string(observe()["clock"]))
		t.Fatal("full bounded wait or real authenticated polling budget failed", code, elapsed, polls)
	}
	var beforeInventory, afterInventory map[string]any
	if json.Unmarshal(beforeClock, &beforeInventory) != nil || json.Unmarshal(observe()["clock"], &afterInventory) != nil {
		t.Fatal("bounded runner inventory clock missing")
	}
	beforeObserved, _ := beforeInventory["provider_observed_at"].(string)
	afterObserved, _ := afterInventory["provider_observed_at"].(string)
	beforeTime, beforeError := time.Parse(time.RFC3339Nano, beforeObserved)
	afterTime, afterError := time.Parse(time.RFC3339Nano, afterObserved)
	if beforeError != nil || afterError != nil || !afterTime.After(beforeTime) ||
		beforeInventory["provider_version"] != afterInventory["provider_version"] || beforeInventory["provider_manifest_id"] != afterInventory["provider_manifest_id"] {
		t.Fatal("ordinary runner inventory did not refresh unchanged provider authority across full wait")
	}
	t.Log("A02_NATIVE_INVENTORY_REFRESH_COMPLETE", beforeObserved, afterObserved)
	checkBrowser(answer(bounded["id"].(string), "a02-after-timeout", "Synthetic durable late answer", false), 200)
	fixture.slowRead.Store(true)
	beforeSlowReads := fixture.reads.Load()
	start = time.Now()
	late, code := fixture.call("bfb_wait_for_attention", "a02-slow-response", map[string]any{"attention_id": bounded["id"]})
	if elapsed := time.Since(start); code != "offline_rejected" || elapsed >= 30*time.Second || len(late) != 0 || fixture.slowRead.Load() || fixture.reads.Load() != beforeSlowReads+1 {
		t.Fatal("slow network escaped full-call deadline or delivered a late answer", code, elapsed)
	}
	if repeated, code := fixture.call("bfb_wait_for_attention", "a02-timeout-wait", map[string]any{"attention_id": bounded["id"]}); code != "" || repeated["status"] != "answered" || !reflect.DeepEqual(repeated["attention"], get(bounded["id"].(string), "a02-timeout-reread")) {
		t.Fatal("pending wait was memoized or durable answer was lost", code)
	}
	t.Log("A02_NATIVE_FULL_WAIT_BOUND_COMPLETE", polls)

	// Every fence applies to cached creation and current private reads, including
	// a new provisional host that omitted its previously confirmed binding.
	for _, closure := range []struct{ kind, code string }{
		{"session", "capability_closed"}, {"end", "assignment_ended"},
		{"result", "capability_closed"}, {"lease", "capability_closed"},
		{"lease_replaced", "capability_closed"}, {"lock_read", "assignment_ended"},
		{"lock_write", "assignment_ended"}, {"grant", "revoked"},
	} {
		fixture.freshScope(false)
		fixture.hook("synthetic-attention-fence-" + closure.kind)
		requestID := "a02-fence-" + closure.kind
		question := "Synthetic fenced current attention"
		created := request(requestID, question)
		get(created["id"].(string), "a02-fence-read-"+closure.kind)
		if closure.kind == "lock_read" {
			fixture.postflightRelease("attention-get")
		} else if closure.kind == "lock_write" {
			fixture.postflightRelease("attention-request")
		} else {
			fixture.post("/__a01/change", map[string]string{"execution": fixture.ids()["execution"], "kind": closure.kind}, false)
		}
		if closure.kind == "lock_write" {
			if _, code := fixture.call("bfb_request_human", requestID+"-committed", requestParams(question)); code != closure.code {
				t.Fatal("post-commit ownership loss released private attention result", code)
			}
			if len(rows(observe(), "attention")) != 2 || len(rows(observe(), "observations")) != 2 {
				t.Fatal("postflight denial incorrectly implied no committed attention effect")
			}
		} else {
			fixture.restart("__restart")
			if _, code := fixture.call("bfb_get_attention", "a02-fence-read-"+closure.kind, map[string]any{"attention_id": created["id"]}); code != closure.code {
				t.Fatal("fresh host bypassed current attention read fence", closure.kind, code)
			}
		}
		if closure.kind != "lock_read" && closure.kind != "lock_write" {
			fixture.restart("__restart")
			if _, code := fixture.call("bfb_request_human", requestID, requestParams(question)); code != closure.code {
				t.Fatal("cloud-cached creation bypassed current attention fence", closure.kind, code)
			}
		}
		if _, code := fixture.call("bfb_request_human", requestID, requestParams(question)); code != "capability_closed" {
			t.Fatal("attention denial did not retain sticky capability closure", closure.kind, code)
		}
		noJournal()
	}
	t.Log("A02_NATIVE_PROOF_COMPLETE")
}

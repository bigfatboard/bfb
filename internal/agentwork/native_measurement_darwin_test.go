// ABOUTME: Proves compiled hook telemetry reaches measurements through the signed daemon and real Worker/D1.
// ABOUTME: Injects bounded network acknowledgements and restarts while preserving genuine historical authority.

//go:build darwin && cgo

package agentwork

import (
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
)

type nativeMeasurementFaults struct {
	outage, unsupported, loseAck, malformedAck          atomic.Bool
	uploads, discoveries, lostReplies, malformedReplies atomic.Int64
	denials                                             atomic.Int64
	lastIngestStatus                                    atomic.Int64
	gzipAcknowledgements, acknowledgementDecodeFailures atomic.Int64
}

func (faults *nativeMeasurementFaults) intercept(writer http.ResponseWriter, request *http.Request) bool {
	path := request.URL.Path
	if strings.HasSuffix(path, "/events/capabilities") {
		faults.discoveries.Add(1)
		if faults.unsupported.Load() {
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"schema_version":1,"accepted_event_versions":[1]}`))
			return true
		}
	}
	if strings.HasSuffix(path, "/events/ingest") {
		if faults.outage.Load() {
			writer.WriteHeader(503)
			_, _ = writer.Write([]byte(`{"error":"synthetic_event_outage"}`))
			return true
		}
		faults.uploads.Add(1)
	}
	return false
}

func (faults *nativeMeasurementFaults) modify(response *http.Response) error {
	if strings.HasSuffix(response.Request.URL.Path, "/events/ingest") {
		faults.lastIngestStatus.Store(int64(response.StatusCode))
	}
	if (response.StatusCode == 401 || response.StatusCode == 403) && (strings.Contains(response.Request.URL.Path, "/events/") || strings.HasSuffix(response.Request.URL.Path, "/challenge")) {
		faults.denials.Add(1)
	}
	if response.StatusCode != 200 || !strings.HasSuffix(response.Request.URL.Path, "/events/ingest") {
		return nil
	}
	if faults.loseAck.Swap(false) {
		// Stop subsequent sends before publishing response loss, not after the client returns.
		faults.outage.Store(true)
		faults.lostReplies.Add(1)
		_ = response.Body.Close()
		return fmt.Errorf("synthetic committed telemetry acknowledgement loss")
	}
	if faults.malformedAck.Swap(false) {
		encoding := response.Header.Get("Content-Encoding")
		if encoding == "gzip" {
			faults.gzipAcknowledgements.Add(1)
		}
		data, err := io.ReadAll(io.LimitReader(response.Body, 65_537))
		_ = response.Body.Close()
		if err == nil && len(data) <= 65_536 && encoding == "gzip" {
			// ReverseProxy preserves the caller's Accept-Encoding. Its upstream Transport
			// therefore does not automatically decompress the genuine Worker reply here.
			var reader *gzip.Reader
			reader, err = gzip.NewReader(bytes.NewReader(data))
			if err == nil {
				data, err = io.ReadAll(io.LimitReader(reader, 65_537))
				_ = reader.Close()
			}
		} else if encoding != "" && encoding != "identity" && encoding != "gzip" {
			err = fmt.Errorf("unsupported synthetic acknowledgement encoding")
		}
		var body map[string]any
		if err != nil || len(data) > 65_536 || json.Unmarshal(data, &body) != nil {
			faults.acknowledgementDecodeFailures.Add(1)
			return fmt.Errorf("bounded synthetic acknowledgement unavailable")
		}
		body["workspace_id"] = daemon.NewRequestID()
		data, err = json.Marshal(body)
		if err != nil {
			return err
		}
		faults.outage.Store(true)
		faults.malformedReplies.Add(1)
		response.Body = io.NopCloser(strings.NewReader(string(data)))
		response.ContentLength = int64(len(data))
		response.Header.Set("Content-Length", fmt.Sprint(len(data)))
		response.Header.Del("Content-Encoding")
	}
	return nil
}

func TestNativeMeasurementCompressedAcknowledgement(t *testing.T) {
	workspace := daemon.NewRequestID()
	data, err := json.Marshal(map[string]any{
		"schema_version": 1, "workspace_id": workspace, "high_water_cursor": 1,
		"dispositions": []any{map[string]any{"schema_version": 1, "event_id": daemon.NewRequestID(),
			"source_stream_id": daemon.NewRequestID(), "source_sequence": 1, "disposition": "accepted"}},
	})
	if err != nil || !protocol.DecodeWireDocument("runner-event-ingest-result", data).OK {
		t.Fatal("invalid closed acknowledgement fixture", err)
	}
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(data); err != nil || writer.Close() != nil {
		t.Fatal("gzip fixture failed", err)
	}
	faults := &nativeMeasurementFaults{}
	faults.malformedAck.Store(true)
	response := &http.Response{StatusCode: 200, Header: http.Header{"Content-Encoding": []string{"gzip"}},
		Request: &http.Request{URL: &url.URL{Path: "/events/ingest"}},
		Body:    io.NopCloser(bytes.NewReader(compressed.Bytes()))}
	if err := faults.modify(response); err != nil {
		t.Fatal("foreign-ACK fixture must decode compressed real replies before rewriting", err)
	}
	defer response.Body.Close()
	actual, err := io.ReadAll(response.Body)
	var changed map[string]any
	if err != nil || json.Unmarshal(actual, &changed) != nil || !protocol.DecodeWireDocument("runner-event-ingest-result", actual).OK || changed["workspace_id"] == workspace {
		t.Fatal("fixture did not produce an otherwise valid foreign-workspace acknowledgement", err)
	}
	if response.Header.Get("Content-Encoding") != "" || !faults.outage.Load() || faults.malformedReplies.Load() != 1 {
		t.Fatal("rewritten plain ACK kept compression metadata or lost its deterministic outage barrier")
	}
}

type nativeMeasurementHook struct {
	Status  int            `json:"status"`
	Receipt map[string]any `json:"receipt"`
}

type nativeMeasurementFixture struct {
	ctx           context.Context
	db            *sql.DB
	paths         daemon.Paths
	server        *httptest.Server
	ids           func() map[string]string
	post          func(string, any, bool) map[string]json.RawMessage
	hook          func(map[string]any) nativeMeasurementHook
	restartDaemon func()
	freshScope    func(bool)
	wait          func(string, func() bool)
	faults        *nativeMeasurementFaults
}

func (fixture nativeMeasurementFixture) read(t *testing.T, path string) map[string]any {
	t.Helper()
	return fixture.readStatus(t, path, http.StatusOK)
}

func (fixture nativeMeasurementFixture) readStatus(t *testing.T, path string, status int) map[string]any {
	t.Helper()
	request, err := http.NewRequestWithContext(fixture.ctx, "GET", fixture.server.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Cookie", os.Getenv("BFB_A01_TEST_COOKIE"))
	response, err := fixture.server.Client().Do(request)
	if err != nil {
		t.Fatal("authenticated measurement read failed", err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 65_537))
	var result map[string]any
	if err != nil || len(data) > 65_536 || response.StatusCode != status || json.Unmarshal(data, &result) != nil {
		t.Fatal("bounded authenticated measurement read failed", response.StatusCode, err)
	}
	if status == http.StatusConflict && response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("held source read must not be cached")
	}
	return result
}

func runNativeMeasurements(t *testing.T, fixture nativeMeasurementFixture) {
	t.Helper()
	original := fixture.ids()["execution"]
	runID := fixture.ids()["run"]
	workspace := fixture.ids()["workspace"]
	observe := func(execution string) map[string]json.RawMessage {
		return fixture.post("/__a04/measurement-observe", map[string]string{"execution": execution}, false)
	}
	rows := func(observation map[string]json.RawMessage, key string) []map[string]any {
		t.Helper()
		var result []map[string]any
		if json.Unmarshal(observation[key], &result) != nil {
			t.Fatal("bounded telemetry observation missing", key)
		}
		return result
	}
	pending := func() int {
		t.Helper()
		var count int
		if err := fixture.db.QueryRow("SELECT COUNT(*) FROM hook_journal WHERE execution_id=? AND json_extract(submission_json,'$.schema_version')=2", original).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	quarantined := func() int {
		t.Helper()
		var count int
		if err := fixture.db.QueryRow("SELECT COUNT(*) FROM hook_quarantine WHERE execution_id=?", original).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	accepted := func(input map[string]any) map[string]any {
		t.Helper()
		result := fixture.hook(input)
		if result.Status != 0 || result.Receipt["hook_status"] != "accepted" {
			t.Fatal("compiled typed hook failed", result.Status, result.Receipt["hook_status"], result.Receipt["hook_code"])
		}
		if _, ok := result.Receipt["hook_event_id"].(string); !ok {
			t.Fatal("hook did not commit original local identity")
		}
		return result.Receipt
	}
	usage := func(id, quality string, input, output any) map[string]any {
		return map[string]any{
			"kind": "usage", "session_id": "synthetic-a04-session", "usage_id": id, "basis": "turn_delta",
			"quality": quality, "model": "synthetic", "input_tokens": input, "output_tokens": output,
			"cache_read_tokens": nil, "cache_write_tokens": nil, "reasoning_tokens": nil,
			"prompt": "A04_PRIVATE_TELEMETRY_CANARY", "tool_output": "A04_PRIVATE_TELEMETRY_CANARY", "cwd": "/synthetic/private",
		}
	}
	// Negotiation failure cannot turn typed usage into payload-free v1 or poison disposal.
	fixture.faults.outage.Store(true)
	fixture.faults.unsupported.Store(true)
	accepted(map[string]any{"kind": "session_started", "session_id": "synthetic-a04-session", "source_event_id": "a04-v1-session"})
	exactInput := usage("a04-exact-usage", "provider_reported", 120, 30)
	exactInput["cache_read_tokens"], exactInput["reasoning_tokens"] = 20, 5
	first := accepted(exactInput)
	fixture.wait("visible unsupported telemetry peer", func() bool {
		var flag, reason string
		return fixture.db.QueryRow("SELECT value FROM hook_journal_meta WHERE key='telemetry_degraded'").Scan(&flag) == nil && fixture.db.QueryRow("SELECT value FROM hook_journal_meta WHERE key='degraded_reason'").Scan(&reason) == nil && flag == "1" && strings.Contains(reason, "upgrade")
	})
	if pending() != 1 || quarantined() != 0 || len(rows(observe(original), "tokens")) != 0 {
		t.Fatal("unsupported peer downgraded, deleted or quarantined typed capture")
	}
	fixture.faults.outage.Store(false)
	fixture.wait("v1 remains usable with an unsupported typed peer", func() bool {
		for _, event := range rows(observe(original), "ledger") {
			if event["kind"] == "session_started" {
				return true
			}
		}
		return false
	})
	if pending() != 1 || len(rows(observe(original), "tokens")) != 0 {
		t.Fatal("v1 delivery silently downgraded typed usage")
	}
	fixture.faults.unsupported.Store(false)
	fixture.faults.loseAck.Store(true)
	fixture.wait("real cloud commit with lost acknowledgement", func() bool {
		return fixture.faults.lostReplies.Load() == 1 && len(rows(observe(original), "tokens")) == 1
	})
	if pending() != 1 || quarantined() != 0 {
		t.Fatal("response loss acknowledged or quarantined local capture")
	}
	var originalSubmission string
	if err := fixture.db.QueryRow("SELECT submission_json FROM hook_journal WHERE event_id=?", first["hook_event_id"]).Scan(&originalSubmission); err != nil {
		t.Fatal(err)
	}
	fixture.restartDaemon()
	var resumedSubmission string
	if err := fixture.db.QueryRow("SELECT submission_json FROM hook_journal WHERE event_id=?", first["hook_event_id"]).Scan(&resumedSubmission); err != nil || resumedSubmission != originalSubmission {
		t.Fatal("restart replaced original telemetry input", err)
	}
	fixture.faults.outage.Store(false)
	fixture.wait("matching real acknowledgement clears exact original", func() bool { return pending() == 0 })
	duplicate := fixture.hook(exactInput)
	if duplicate.Status != 0 || duplicate.Receipt["hook_status"] != "duplicate" || duplicate.Receipt["hook_event_id"] != first["hook_event_id"] || pending() != 0 {
		t.Fatal("persistent local identity failed after acknowledgement/restart", duplicate.Status, duplicate.Receipt["hook_status"])
	}
	changed := usage("a04-exact-usage", "provider_reported", 121, 30)
	changed["cache_read_tokens"], changed["reasoning_tokens"] = 20, 5
	conflict := fixture.hook(changed)
	if conflict.Receipt["hook_status"] != "rejected" || conflict.Receipt["hook_code"] != "telemetry_identity_conflict" {
		t.Fatal("changed usage under stable identity did not conflict", conflict.Receipt["hook_status"], conflict.Receipt["hook_code"])
	}
	t.Log("A04_NATIVE_ACK_RESTART_DEDUPE_COMPLETE")

	// Quality classes preserve null-versus-zero; cache/reasoning are subsets, not another exact total.
	fixture.faults.malformedAck.Store(true)
	estimatedCapture := accepted(usage("a04-estimated-usage", "estimated", 7, 0))
	lastState := ""
	fixture.wait("cross-workspace acknowledgement retained", func() bool {
		var failures int
		var due, reason string
		_ = fixture.db.QueryRow("SELECT COALESCE(MAX(failures),0),COALESCE(MIN(next_attempt_at),'') FROM hook_source_streams").Scan(&failures, &due)
		_ = fixture.db.QueryRow("SELECT value FROM hook_journal_meta WHERE key='degraded_reason'").Scan(&reason)
		state := fmt.Sprint(fixture.faults.malformedReplies.Load(), "/", pending(), "/", quarantined(), "/", fixture.faults.uploads.Load(), "/", fixture.faults.discoveries.Load(), "/", fixture.faults.lastIngestStatus.Load(), "/", failures, "/", due, "/", reason, "/", fixture.faults.gzipAcknowledgements.Load(), "/", fixture.faults.acknowledgementDecodeFailures.Load())
		if state != lastState {
			t.Log("A04 bounded foreign-ACK state modified/pending/quarantine/uploads/discovery/status/failures/due/reason/gzip/decodeFailures", state)
			lastState = state
		}
		return fixture.faults.malformedReplies.Load() == 1 && pending() == 1
	})
	if quarantined() != 0 {
		t.Fatal("malformed acknowledgement poisoned a valid typed capture")
	}
	// The foreign ACK must follow the typed commit, not consume the fault on an
	// unrelated background v1 batch while the estimated usage is merely unsent.
	committedBeforeRetry := observe(original)
	committedTokens := rows(committedBeforeRetry, "tokens")
	estimatedCommitted := false
	for _, token := range committedTokens {
		if token["observation_id"] == estimatedCapture["hook_event_id"] && token["quality"] == "estimated" && token["input_tokens"] == float64(7) && token["output_tokens"] == float64(0) {
			estimatedCommitted = true
		}
	}
	estimatedIdentity := false
	for _, event := range rows(committedBeforeRetry, "ledger") {
		if event["event_id"] != estimatedCapture["hook_event_id"] {
			continue
		}
		var payload map[string]any
		encoded, ok := event["payload_json"].(string)
		if ok && json.Unmarshal([]byte(encoded), &payload) == nil && payload["usage_id"] == "a04-estimated-usage" {
			estimatedIdentity = true
		}
	}
	if !fixture.faults.outage.Load() || len(committedTokens) != 2 || !estimatedCommitted || !estimatedIdentity {
		t.Fatal("foreign acknowledgement retained an unsent row rather than the original committed estimated usage")
	}
	fixture.faults.outage.Store(false)
	fixture.wait("corrected acknowledgement replay", func() bool { return pending() == 0 })
	accepted(usage("a04-unavailable-usage", "unavailable", nil, nil))
	accepted(map[string]any{"kind": "turn_started", "session_id": "synthetic-a04-session", "activity_id": "a04-turn", "source_event_id": "a04-turn-start"})
	accepted(map[string]any{"kind": "tool_started", "session_id": "synthetic-a04-session", "activity_id": "a04-tool", "parent_turn_id": "a04-turn", "source_event_id": "a04-tool-start"})
	accepted(map[string]any{"kind": "tool_completed", "session_id": "synthetic-a04-session", "activity_id": "a04-tool", "parent_turn_id": "a04-turn", "source_event_id": "a04-tool-finish"})
	accepted(map[string]any{"kind": "turn_completed", "session_id": "synthetic-a04-session", "activity_id": "a04-turn", "source_event_id": "a04-turn-finish"})
	fixture.wait("typed quality/activity observations uploaded", func() bool { return pending() == 0 && len(rows(observe(original), "tokens")) == 3 })
	measured := fixture.read(t, "/api/v1/workspaces/"+workspace+"/runs/"+runID+"/measurements")
	measurements, ok := measured["measurements"].(map[string]any)
	if !ok {
		t.Fatal("measurement API missing committed view")
	}
	tokens := measurements["tokens"].(map[string]any)
	exact := tokens["exact"].(map[string]any)
	estimated := tokens["estimated"].(map[string]any)
	if exact["input"] != float64(120) || exact["output"] != float64(30) || exact["cache_read"] != float64(20) || exact["reasoning"] != float64(5) || exact["cache_write"] != nil || estimated["input"] != float64(7) || estimated["output"] != float64(0) || tokens["unavailable_count"] != float64(1) {
		t.Fatal("measurement API conflated quality, missing fields or reported zero")
	}
	publicSources, sourcesPresent := measurements["sources"]
	if !sourcesPresent || publicSources != nil {
		t.Fatal("public source page must be explicitly unavailable")
	}
	sources := fixture.readStatus(t, "/api/v1/workspaces/"+workspace+"/runs/"+runID+"/measurement-sources?limit=100", http.StatusConflict)
	if strings.Contains(fmt.Sprint(sources), "A04_PRIVATE_TELEMETRY_CANARY") || strings.Contains(fmt.Sprint(sources), "/synthetic/private") {
		t.Fatal("source metadata exposed raw provider content")
	}
	if len(sources) != 2 || sources["error"] != "request_rejected" || sources["message"] != "event feeds are unavailable" {
		t.Fatal("public source read did not preserve the uniform hold")
	}
	canonical := rows(observe(original), "ledger")
	exactIdentity := false
	for _, event := range canonical {
		if event["event_id"] != first["hook_event_id"] {
			continue
		}
		var payload map[string]any
		encoded, ok := event["payload_json"].(string)
		if ok && json.Unmarshal([]byte(encoded), &payload) == nil && payload["usage_id"] == "a04-exact-usage" && event["run_execution_id"] == original && event["assignment_generation"] == float64(1) {
			exactIdentity = true
		}
	}
	if !exactIdentity {
		t.Fatal("retained exact usage lost its captured event and assignment identity")
	}
	activity := map[string]bool{}
	for _, event := range canonical {
		if strings.HasPrefix(fmt.Sprint(event["kind"]), "turn_") || strings.HasPrefix(fmt.Sprint(event["kind"]), "tool_") {
			activity[fmt.Sprint(event["kind"])] = true
		}
	}
	for _, kind := range []string{"turn_started", "turn_stopped", "tool_started", "tool_finished"} {
		if !activity[kind] {
			t.Fatal("phase-aware local dedupe suppressed matching activity", kind)
		}
	}
	t.Log("A04_NATIVE_MEASUREMENT_API_QUALITY_COMPLETE")

	// Captured telemetry survives end/new execution: replay uses historical assignment, not live write authority.
	fixture.faults.outage.Store(true)
	accepted(usage("a04-historical-offline-usage", "provider_reported", 4, 2))
	if pending() != 1 {
		t.Fatal("offline capture did not remain durable")
	}
	fixture.post("/__a04/end", map[string]string{"execution": original}, false)
	fixture.post("/__a04/profile-change", map[string]string{"execution": original}, false)
	fixture.freshScope(true)
	newExecution := fixture.ids()["execution"]
	fixture.restartDaemon()
	fixture.faults.outage.Store(false)
	fixture.wait("ended assignment replay retains original attribution", func() bool { return pending() == 0 && len(rows(observe(original), "tokens")) == 4 })
	for _, token := range rows(observe(original), "tokens") {
		if token["provider"] != "fake" || token["run_execution_id"] != original || token["run_id"] != runID {
			t.Fatal("telemetry followed mutable profile or active assignment")
		}
	}
	if len(rows(observe(newExecution), "tokens")) != 0 {
		t.Fatal("historical telemetry attached to the replacement execution")
	}
	privacy := observe(original)
	var receiptPrivacy struct {
		Total           int `json:"total"`
		PrivatePayloads int `json:"private_payloads"`
	}
	if json.Unmarshal(privacy["privacy"], &receiptPrivacy) != nil || receiptPrivacy.Total == 0 || receiptPrivacy.PrivatePayloads != 0 {
		t.Fatal("typed usage/private content leaked through receipts")
	}
	t.Log("A04_NATIVE_HISTORICAL_ASSIGNMENT_OFFLINE_COMPLETE")

	// Current enrollment/project authority still fences historical delivery; pending data is not erased.
	fixture.faults.outage.Store(true)
	revoked := accepted(usage("a04-revoked-usage", "provider_reported", 9, 1))
	fixture.post("/__a04/revoke-project", map[string]string{"execution": newExecution}, false)
	before := fixture.faults.denials.Load()
	fixture.faults.outage.Store(false)
	fixture.wait("current revoked grant rejects real transport", func() bool { return fixture.faults.denials.Load() > before })
	if len(rows(observe(newExecution), "tokens")) != 0 {
		t.Fatal("revoked current grant delivered queued telemetry")
	}
	var retained int
	if fixture.db.QueryRow("SELECT COUNT(*) FROM hook_journal WHERE event_id=? AND json_extract(submission_json,'$.schema_version')=2", revoked["hook_event_id"]).Scan(&retained) != nil || retained != 1 {
		t.Fatal("revoked telemetry was silently discarded")
	}
	t.Log("A04_NATIVE_PROOF_COMPLETE")
}

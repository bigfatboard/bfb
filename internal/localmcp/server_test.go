// ABOUTME: Proves stdio stdout purity, startup-race visibility, and session behavior over pipes.
// ABOUTME: Pins the committed MCP inspector transcript byte-for-byte against the live server.

package localmcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type stdioHarness struct {
	server *Server
	stdin  *bytes.Buffer
	stdout *bytes.Buffer
	stderr *bytes.Buffer
}

func newStdioHarness(env ScopedEnv, assignments AssignmentSource, bindings *fakeBindings, authority *fakeAuthority, transport *fakeTransport, journal Journal) *stdioHarness {
	if bindings == nil {
		bindings = &fakeBindings{}
	}
	if authority == nil {
		authority = &fakeAuthority{}
	}
	deps := Deps{
		Env:         env,
		Inspector:   stubInspector{},
		Assignments: assignments,
		Bindings:    bindings,
		Authority:   authority,
		Transport:   transport,
		Journal:     journal,
		Policy:      DefaultOfflinePolicy{AllowPending: true},
		Principal:   "agent_run:" + syntheticBoundary.RunID,
		Grant:       "synthetic-grant",
		Stderr:      &bytes.Buffer{},
	}
	harness := &stdioHarness{stdin: &bytes.Buffer{}, stdout: &bytes.Buffer{}, stderr: deps.Stderr.(*bytes.Buffer)}
	harness.server = NewServer(context.Background(), deps)
	return harness
}

type stubInspector struct{ facts PeerFacts }

func (stub stubInspector) Inspect() (PeerFacts, error) { return stub.facts, nil }

func syntheticEnv() ScopedEnv {
	return ScopedEnv{
		WorkspaceID: syntheticBoundary.WorkspaceID, ProjectID: syntheticBoundary.ProjectID,
		TaskID: syntheticBoundary.TaskID, RunID: syntheticBoundary.RunID,
		ExecutionID: syntheticBoundary.ExecutionID, Generation: syntheticBoundary.Generation,
		CheckoutID: syntheticBoundary.CheckoutID, Correlation: syntheticCorrelation,
		ArtifactsDir: "/tmp/synthetic-artifacts", RunnerID: syntheticBoundary.RunnerID, DaemonUID: 501,
	}
}

func happyHarness(journal Journal) (*stdioHarness, *fakeBindings) {
	assignments := &fakeAssignments{record: syntheticAssignment()}
	bindings := &fakeBindings{}
	deps := Deps{
		Env:         syntheticEnv(),
		Inspector:   stubInspector{facts: syntheticFacts()},
		Assignments: assignments,
		Bindings:    bindings,
		Authority:   &fakeAuthority{},
		Transport:   syntheticTransport(),
		Journal:     journal,
		Policy:      DefaultOfflinePolicy{AllowPending: true},
		Principal:   "agent_run:" + syntheticBoundary.RunID,
		Grant:       "synthetic-grant",
		Stderr:      &bytes.Buffer{},
	}
	harness := &stdioHarness{stdin: &bytes.Buffer{}, stdout: &bytes.Buffer{}}
	harness.stderr = deps.Stderr.(*bytes.Buffer)
	harness.server = NewServer(context.Background(), deps)
	if harness.server.startupErr != nil {
		panic("happy harness failed verification: " + harness.server.startupErr.Error())
	}
	return harness, bindings
}

func TestStdoutPurityAndSessionFlow(t *testing.T) {
	harness, bindings := happyHarness(nil)
	ref := AssignmentRef{ExecutionID: syntheticBoundary.ExecutionID, AssignmentGeneration: syntheticBoundary.Generation, RunID: syntheticBoundary.RunID}
	session := []string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"bfb_get_task","arguments":{"request_id":"purity-001"}}}`,
		`not json at all`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"bfb_add_comment","arguments":{"body":"Too early","request_id":"purity-002"}}}`,
		`{"jsonrpc":"2.0","id":5,"method":"prompts/get","params":{}}`,
		`{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"bfb_request_human","arguments":{"request_id":"purity-003"}}}`,
	}
	for _, line := range session[:6] {
		harness.server.serveLine(context.Background(), bufio.NewWriter(harness.stdout), []byte(line+"\n"))
	}
	bindings.setBound(syntheticSession, ref)
	for _, line := range session[6:] {
		harness.server.serveLine(context.Background(), bufio.NewWriter(harness.stdout), []byte(line+"\n"))
	}
	raw := harness.stdout.String()
	lines := strings.Split(strings.TrimSpace(raw), "\n")
	if len(lines) != 7 {
		t.Fatalf("expected 7 stdout lines (notification is silent), got %d:\n%s", len(lines), raw)
	}
	responses := make([]map[string]any, 0, len(lines))
	for index, line := range lines {
		var value map[string]any
		decoder := json.NewDecoder(strings.NewReader(line))
		decoder.UseNumber()
		if err := decoder.Decode(&value); err != nil {
			t.Fatalf("stdout line %d is not JSON: %q", index, line)
		}
		if value["jsonrpc"] != "2.0" {
			t.Fatalf("stdout line %d is not JSON-RPC: %q", index, line)
		}
		responses = append(responses, value)
	}
	// responses[0] initialize, [1] tools/list, [2] get_task ok, [3] parse error,
	// [4] provisional rejection, [5] unknown method, [6] attention validation.
	if responses[2]["error"] != nil {
		t.Fatalf("provisional get_task failed: %v", responses[2])
	}
	assertBFBCode(t, responses[3], "parse_error")
	assertBFBCode(t, responses[4], "session_not_bound")
	assertBFBCode(t, responses[5], "method_not_found")
	assertBFBCode(t, responses[6], "invalid_params")
	if harness.stderr.String() == "" {
		t.Fatalf("expected stderr diagnostics")
	}
	for _, leak := range []string{syntheticCorrelation, "Synthetic brief", "Too early"} {
		if strings.Contains(harness.stdout.String(), leak) || strings.Contains(harness.stderr.String(), leak) {
			t.Fatalf("response or diagnostic leaks private material: %q", leak)
		}
	}
}

func assertBFBCode(t *testing.T, response map[string]any, code string) {
	t.Helper()
	failure, ok := response["error"].(map[string]any)
	if !ok {
		t.Fatalf("expected error response with %s, got %+v", code, response)
	}
	data, _ := failure["data"].(map[string]any)
	if data["bfb_code"] != code {
		t.Fatalf("expected bfb_code %s, got %+v", code, response)
	}
}

func TestStdioProgressPreservesRawNumberBounds(t *testing.T) {
	for _, test := range []struct {
		name, percent, confidence string
		accept                    bool
	}{
		{"fraction", "12.5", "0.75", true},
		{"exponent", "125e-1", "75e-2", true},
		{"explicit-zero", "-0e9999999999", "0e-9999999999", true},
		{"rounded-percent", "100.00000000000000001", "0.75", false},
		{"rounded-confidence", "12.5", "1.00000000000000001", false},
		{"percent-underflow", "1e-324", "0.75", false},
		{"confidence-underflow", "12.5", "1e-324", false},
		{"overflow", "1e999", "0.75", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			harness, bindings := happyHarness(nil)
			bindings.setBound(syntheticSession, harness.server.capability.ref())
			line := fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bfb_report_progress","arguments":{"summary":"Synthetic raw-number checkpoint","request_id":"raw-progress-001","percent":%s,"confidence":%s}}}`, test.percent, test.confidence)
			harness.server.serveLine(context.Background(), bufio.NewWriter(harness.stdout), []byte(line))
			var reply map[string]any
			if err := json.Unmarshal(harness.stdout.Bytes(), &reply); err != nil {
				t.Fatal(err)
			}
			transport := harness.server.host.transport.(*fakeTransport)
			if test.accept {
				if reply["error"] != nil || len(transport.progress) != 1 {
					t.Fatal("valid raw progress rejected", reply)
				}
			} else {
				assertBFBCode(t, reply, "invalid_params")
				if len(transport.progress) != 0 || harness.server.capability.State() != StateProvisional {
					t.Fatal("invalid raw progress activated or wrote")
				}
			}
		})
	}
}

func TestStdioProgressCanonicalNumericRetry(t *testing.T) {
	for _, test := range []struct {
		name, percent, confidence, retryPercent, retryConfidence string
		firstInvalid                                             bool
	}{
		{"equivalent-exponent", "125e-1", "75e-2", "12.5", "0.75", false},
		{"equivalent-zero", "-0e9999999999", "0e-9999999999", "0", "0", false},
		{"invalid-first", "100.00000000000000001", "1e-324", "12.5", "0.75", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			harness, bindings := happyHarness(nil)
			bindings.setBound(syntheticSession, harness.server.capability.ref())
			call := func(id int, percent, confidence string) map[string]any {
				t.Helper()
				harness.stdout.Reset()
				line := fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":"bfb_report_progress","arguments":{"summary":"Synthetic equivalent-number checkpoint","request_id":"retry-progress-001","percent":%s,"confidence":%s}}}`, id, percent, confidence)
				harness.server.serveLine(context.Background(), bufio.NewWriter(harness.stdout), []byte(line))
				var reply map[string]any
				if err := json.Unmarshal(harness.stdout.Bytes(), &reply); err != nil {
					t.Fatal(err)
				}
				return reply
			}
			first := call(1, test.percent, test.confidence)
			transport := harness.server.host.transport.(*fakeTransport)
			if test.firstInvalid {
				assertBFBCode(t, first, "invalid_params")
				if len(transport.progress) != 0 || len(harness.server.host.seen) != 0 {
					t.Fatal("invalid raw input wrote or consumed the request identity")
				}
			} else if first["error"] != nil {
				t.Fatal("valid initial numeric spelling rejected", first)
			}
			retry := call(2, test.retryPercent, test.retryConfidence)
			if retry["error"] != nil || len(transport.progress) != 1 || transport.calls["retry-progress-001"] != 1 {
				t.Fatal("equivalent numeric retry failed or duplicated its effect", retry)
			}
			if !test.firstInvalid {
				firstResult, err := json.Marshal(first["result"])
				if err != nil {
					t.Fatal(err)
				}
				retryResult, err := json.Marshal(retry["result"])
				if err != nil || !bytes.Equal(firstResult, retryResult) {
					t.Fatal("equivalent numeric retry changed its original receipt", retry)
				}
			}
			changed := call(3, "13", "0.75")
			assertBFBCode(t, changed, "request_rejected")
			if len(transport.progress) != 1 {
				t.Fatal("changed numeric payload escaped the request fingerprint")
			}
		})
	}
}

func TestStdioUpdatePreservesRawIntegerBounds(t *testing.T) {
	for _, test := range []struct {
		name, version string
		accept        bool
	}{
		{"integer", "3", true},
		{"integral-decimal", "3.0", true},
		{"integral-exponent", "30e-1", true},
		{"rounded-fraction", "3.00000000000000001", false},
		{"fraction", "3.5", false},
		{"unsafe-integer", "9007199254740992", false},
		{"underflow", "1e-324", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			harness, bindings := happyHarness(nil)
			bindings.setBound(syntheticSession, harness.server.capability.ref())
			call := func(id int, version string) map[string]any {
				t.Helper()
				harness.stdout.Reset()
				line := fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":"bfb_update_task","arguments":{"title":"Synthetic integer checkpoint","request_id":"raw-update-001","expected_version":%s}}}`, id, version)
				harness.server.serveLine(context.Background(), bufio.NewWriter(harness.stdout), []byte(line))
				var reply map[string]any
				if err := json.Unmarshal(harness.stdout.Bytes(), &reply); err != nil {
					t.Fatal(err)
				}
				return reply
			}
			reply := call(1, test.version)
			transport := harness.server.host.transport.(*fakeTransport)
			if test.accept {
				if reply["error"] != nil || len(transport.updated) != 1 {
					t.Fatal("valid integral spelling rejected", reply)
				}
			} else {
				assertBFBCode(t, reply, "invalid_params")
				if len(transport.updated) != 0 || harness.server.capability.State() != StateProvisional {
					t.Fatal("invalid raw integer activated or wrote")
				}
			}
			retry := call(2, "3")
			if retry["error"] != nil || len(transport.updated) != 1 || transport.calls["raw-update-001"] != 1 {
				t.Fatal("canonical update retry rejected or duplicated", retry)
			}
			if test.accept {
				firstResult, err := json.Marshal(reply["result"])
				if err != nil {
					t.Fatal(err)
				}
				retryResult, err := json.Marshal(retry["result"])
				if err != nil || !bytes.Equal(firstResult, retryResult) {
					t.Fatal("canonical update retry changed its original receipt", retry)
				}
			}
		})
	}
}

func TestStartupRaceFailsVisibleAndPure(t *testing.T) {
	assignments := &fakeAssignments{err: fail("assignment_unknown")}
	harness := newStdioHarness(syntheticEnv(), assignments, &fakeBindings{}, &fakeAuthority{}, syntheticTransport(), nil)
	harness.server.serveLine(context.Background(), bufio.NewWriter(harness.stdout), []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`+"\n"))
	harness.server.serveLine(context.Background(), bufio.NewWriter(harness.stdout), []byte(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"bfb_get_task","arguments":{"request_id":"race-0001"}}}`+"\n"))
	lines := strings.Split(strings.TrimSpace(harness.stdout.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 visible failures, got:\n%s", harness.stdout.String())
	}
	for _, line := range lines {
		var value map[string]any
		if err := json.Unmarshal([]byte(line), &value); err != nil || value["jsonrpc"] != "2.0" || value["error"] == nil {
			t.Fatalf("startup failure not a visible JSON-RPC error: %q", line)
		}
		assertBFBCode(t, value, "assignment_unknown")
	}
}

func TestGoldenInspectorTranscript(t *testing.T) {
	path := filepath.Join("testdata", "inspector-transcript.jsonl")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	harness, bindings := happyHarness(nil)
	ref := AssignmentRef{ExecutionID: syntheticBoundary.ExecutionID, AssignmentGeneration: syntheticBoundary.Generation, RunID: syntheticBoundary.RunID}
	var output bytes.Buffer
	writer := bufio.NewWriter(&output)
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var frame struct {
			Direction string          `json:"direction"`
			Bind      bool            `json:"bind"`
			Payload   json.RawMessage `json:"payload"`
		}
		if err := json.Unmarshal([]byte(line), &frame); err != nil {
			t.Fatal(err)
		}
		if frame.Direction != "client" {
			t.Fatalf("transcript must contain only client frames: %q", line)
		}
		if frame.Bind {
			bindings.setBound(syntheticSession, ref)
		}
		harness.server.serveLine(context.Background(), writer, append(frame.Payload, '\n'))
	}
	writer.Flush()
	// Owning command: BFB_UPDATE_MCP_TRANSCRIPT=1 go test ./internal/localmcp -run TestGoldenInspectorTranscript.
	if os.Getenv("BFB_UPDATE_MCP_TRANSCRIPT") == "1" {
		if err := os.WriteFile(filepath.Join("testdata", "inspector-transcript.expected.jsonl"), output.Bytes(), 0600); err != nil {
			t.Fatal(err)
		}
	}
	expected, err := os.ReadFile(filepath.Join("testdata", "inspector-transcript.expected.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if output.String() != string(expected) {
		t.Fatalf("server responses diverge from the frozen transcript.\nGot:\n%s\nWant:\n%s", output.String(), string(expected))
	}
}

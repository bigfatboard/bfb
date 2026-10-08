// ABOUTME: Proves explicit online publication through compiled clients, signed native authority and real Worker/R2.
// ABOUTME: Preserves immutable operation identity across lost replies without journal or autonomous artifact recovery.

//go:build darwin && cgo

package agentwork

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/checkout"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
)

func createNativeArtifactCheckout(t *testing.T, ctx context.Context, paths daemon.Paths, directory, workspace, runner, project, canonical string) checkout.Record {
	t.Helper()
	root, err := os.MkdirTemp(directory, "checkout-")
	if err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"init", "--initial-branch=main"}, {"remote", "add", "origin", "https://github.com/synthetic/a01.git"}} {
		command := exec.CommandContext(ctx, "/usr/bin/git", args...)
		command.Dir = root
		command.Env = []string{"PATH=/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0"}
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatal("synthetic local Git setup", err, string(output))
		}
	}
	if os.Mkdir(filepath.Join(root, ".bfb"), 0700) != nil || os.WriteFile(filepath.Join(root, ".bfb/config.yaml"), []byte(canonical), 0600) != nil {
		t.Fatal("synthetic canonical checkout policy")
	}
	db, err := sql.Open("sqlite", "file:"+paths.Database+"?mode=rw&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	registered, err := checkout.NewRegistry(db).Link(ctx, checkout.LinkInput{WorkspaceID: workspace, RunnerID: runner, ProjectID: project, Path: root, RepositoryIdentity: "github.com/synthetic/a01", WorkspaceSubpath: ".", RemoteName: "origin", Label: "Synthetic V01 checkout"})
	if err != nil {
		t.Fatal("actual synthetic checkout registration", err)
	}
	return registered
}

type nativeArtifactFixture struct {
	ctx               context.Context
	workDB            *sql.DB
	paths             daemon.Paths
	ids               func() map[string]string
	directory         func() string
	call              func(string, string, map[string]any) (map[string]any, string)
	publishCLI        func([]string) (map[string]any, int)
	post              func(string, any, bool) map[string]json.RawMessage
	restart           func(string)
	restartDaemon     func()
	stopMCP           func()
	freshScope        func(bool)
	hook              func(string)
	wait              func(string, func() bool)
	postflightRelease func(string)
	outage            *atomic.Bool
	loseReply         *atomic.Pointer[string]
	businessRequests  *atomic.Int64
	uploads           *atomic.Int64
}

func runNativeArtifacts(t *testing.T, fixture nativeArtifactFixture) {
	t.Helper()
	const file = "V01_PATH_CANARY.md"
	const original = "# Synthetic review\nV01_PRIVATE_ARTIFACT_CANARY\n"
	digest := sha256.Sum256([]byte(original))
	expectedHash := hex.EncodeToString(digest[:])
	expectedResultRows := map[string]int{}
	writeFile := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(fixture.directory(), name), []byte(content), 0600); err != nil {
			t.Fatal("private synthetic artifact file", err)
		}
	}
	observe := func() map[string]json.RawMessage {
		return fixture.post("/__v01/artifact-observe", map[string]string{"execution": fixture.ids()["execution"]}, false)
	}
	rows := func(observed map[string]json.RawMessage, field string) []map[string]any {
		t.Helper()
		var result []map[string]any
		if json.Unmarshal(observed[field], &result) != nil {
			t.Fatal("bounded canonical artifact observation missing", field)
		}
		return result
	}
	noJournal := func() {
		t.Helper()
		var count int
		if err := fixture.workDB.QueryRow("SELECT COUNT(*) FROM work_intents WHERE capture_family NOT IN ('agent_work','agent_result')").Scan(&count); err != nil || count != 0 {
			t.Fatal("artifact widened protected journal", count, err)
		}
		execution := fixture.ids()["execution"]
		if err := fixture.workDB.QueryRow("SELECT COUNT(*) FROM work_intents WHERE json_extract(request_json,'$.reference.run_execution_id')=?", execution).Scan(&count); err != nil || count != expectedResultRows[execution] {
			t.Fatal("online artifact produced an extra business intent", count, err)
		}
		if err := fixture.workDB.QueryRow("SELECT COUNT(*) FROM work_intents WHERE json_extract(request_json,'$.reference.run_execution_id')=? AND capture_family='agent_result' AND tool='bfb_submit_result'", execution).Scan(&count); err != nil || count != expectedResultRows[execution] {
			t.Fatal("legitimate result history confused with artifact capture", count, err)
		}
	}
	check := func(result map[string]any, code string) map[string]any {
		t.Helper()
		data, err := json.Marshal(result)
		if code != "" || err != nil || !protocol.DecodeWireDocument("agent-artifact-result", data).OK || result["content_hash"] != expectedHash || result["size"] != float64(len(original)) || result["format"] != "markdown" || result["role"] != "review" {
			t.Fatal("compiled artifact missing bounded final projection", code)
		}
		origin, ok := result["origin"].(map[string]any)
		if !ok || origin["run_id"] != fixture.ids()["run"] || origin["run_execution_id"] != fixture.ids()["execution"] || origin["assignment_generation"] != float64(1) || origin["provider_session_id"] == nil {
			t.Fatal("artifact lost canonical source origin")
		}
		for _, private := range []string{"secret", "upload", "r2_key", "path", original} {
			if strings.Contains(string(data), private) {
				t.Fatal("artifact private data in public projection", private)
			}
		}
		return result
	}
	params := func(path string) map[string]any {
		return map[string]any{"path": path, "format": "markdown", "role": "review"}
	}
	cli := func(id, path string) (map[string]any, string, int) {
		t.Helper()
		result, status := fixture.publishCLI([]string{"--request-id", id, "--file", path, "--format", "markdown", "--role", "review"})
		if failure, ok := result["error"].(map[string]any); ok {
			code, _ := failure["code"].(string)
			return nil, code, status
		}
		return result, "", status
	}
	singleEffect := func(state string) map[string]json.RawMessage {
		t.Helper()
		observed := observe()
		operations, versions := rows(observed, "operations"), rows(observed, "versions")
		if len(operations) != 1 || len(versions) != 1 || versions[0]["state"] != state || versions[0]["declared_size"] != float64(len(original)) || versions[0]["expected_digest"] != expectedHash {
			t.Fatal("publication did not converge to one canonical operation/version", state, len(operations), len(versions))
		}
		if operations[0]["version_id"] != versions[0]["id"] || operations[0]["artifact_id"] != versions[0]["artifact_id"] || operations[0]["execution_id"] != fixture.ids()["execution"] || operations[0]["assignment_generation"] != float64(1) || versions[0]["created_by_human_id"] != nil {
			t.Fatal("artifact origin misattributed or rebound")
		}
		for _, grant := range rows(observed, "grants") {
			value, _ := grant["grant_hash"].(string)
			if len(value) != 64 {
				t.Fatal("upload credential not hashed")
			}
		}
		var privacy struct {
			Total   int `json:"total"`
			Private int `json:"private_payloads"`
		}
		if json.Unmarshal(observed["privacy"], &privacy) != nil || privacy.Total == 0 || privacy.Private != 0 {
			t.Fatal("private artifact payload copied into receipts", privacy.Total, privacy.Private)
		}
		noJournal()
		return observed
	}
	verifyBytes := func(observed map[string]json.RawMessage) {
		t.Helper()
		objects, receipts := rows(observed, "objects"), rows(observed, "receipts")
		if len(objects) != 1 || objects[0]["content_hash"] != expectedHash || objects[0]["size"] != float64(len(original)) || len(receipts) != 1 || receipts[0]["content_hash"] != expectedHash || receipts[0]["grant_id"] == nil || receipts[0]["attempt_id"] == nil {
			t.Fatal("real R2 bytes lacked exact consumption-bound verified receipt")
		}
	}
	start := func(suffix string) { fixture.hook("synthetic-artifact-" + suffix); writeFile(file, original) }
	start("first")
	sendsBefore, uploadsBefore := fixture.businessRequests.Load(), fixture.uploads.Load()
	for index, path := range []string{"../" + file, filepath.Join(fixture.directory(), file)} {
		if _, code := fixture.call("bfb_publish_artifact", "native-artifact-path-"+string(rune('0'+index)), params(path)); code != "invalid_params" {
			t.Fatal("compiled publication accepted a public boundary path", code)
		}
	}
	for _, alias := range []string{"symlink.md", "hardlink.md"} {
		name := filepath.Join(fixture.directory(), alias)
		var err error
		if alias == "symlink.md" {
			err = os.Symlink(file, name)
		} else {
			err = os.Link(filepath.Join(fixture.directory(), file), name)
		}
		if err != nil {
			t.Fatal("synthetic unsafe artifact alias setup", err)
		}
		if _, code := fixture.call("bfb_publish_artifact", "native-artifact-alias-"+alias, params(alias)); code != "request_rejected" {
			t.Fatal("compiled daemon followed an unsafe pinned-file alias", alias, code)
		}
		if err := os.Remove(name); err != nil {
			t.Fatal("synthetic alias cleanup", err)
		}
	}
	if fixture.businessRequests.Load() != sendsBefore || fixture.uploads.Load() != uploadsBefore || len(rows(observe(), "operations")) != 0 {
		t.Fatal("unsafe local artifact selection reached a cloud publication phase")
	}
	noJournal()
	first, code := fixture.call("bfb_publish_artifact", "native-artifact-001", params(file))
	check(first, code)
	verifyBytes(singleEffect("available"))
	writeFile("same-bytes.md", original)
	repeat, code := fixture.call("bfb_publish_artifact", "native-artifact-001", params("same-bytes.md"))
	check(repeat, code)
	if repeat["version_id"] != first["version_id"] || repeat["operation_key"] != first["operation_key"] {
		t.Fatal("safe equivalent path changed publication identity")
	}
	writeFile(file, "changed bytes")
	if _, code := fixture.call("bfb_publish_artifact", "native-artifact-001", params(file)); code != "request_conflict" {
		t.Fatal("changed bytes reused committed operation", code)
	}
	writeFile(file, original)
	exact, code := fixture.call("bfb_publish_artifact", "native-artifact-001", params(file))
	check(exact, code)
	if exact["version_id"] != first["version_id"] {
		t.Fatal("artifact conflict closed exact original MCP recovery")
	}
	cliResult, cliCode, status := cli("native-artifact-001", file)
	check(cliResult, cliCode)
	if status != 0 || cliResult["version_id"] != first["version_id"] {
		t.Fatal("fresh bound CLI lost original publication")
	}
	verifyBytes(singleEffect("available"))
	// Use the actual result lane and authorized human review, not raw result
	// state edits, to distinguish a still-active Submitted run from acceptance.
	submitted, code := fixture.call("bfb_submit_result", "native-artifact-result-001", map[string]any{"summary": "Synthetic V01 publication ready for review"})
	data, err := json.Marshal(submitted)
	if code != "" || err != nil || !protocol.DecodeWireDocument("agent-result-result", data).OK || submitted["result_state"] != "submitted" {
		t.Fatal("genuine submitted result eligibility fixture failed", code)
	}
	expectedResultRows[fixture.ids()["execution"]] = 1
	noJournal()
	result, code := fixture.call("bfb_publish_artifact", "native-artifact-001", params(file))
	check(result, code)
	if result["version_id"] != first["version_id"] {
		t.Fatal("Submitted run changed original publication")
	}
	cliResult, cliCode, status = cli("native-artifact-001", file)
	check(cliResult, cliCode)
	if status != 0 || cliResult["version_id"] != first["version_id"] {
		t.Fatal("fresh bound CLI denied an active Submitted run", status)
	}
	selected := params(file)
	selected["artifact_id"] = first["artifact_id"]
	second, code := fixture.call("bfb_publish_artifact", "native-artifact-submitted-new", selected)
	check(second, code)
	if second["artifact_id"] != first["artifact_id"] || second["version_id"] == first["version_id"] || second["operation_key"] == first["operation_key"] {
		t.Fatal("new publication identity did not create its own version")
	}
	beforeAccept := observe()
	if len(rows(beforeAccept, "operations")) != 2 || len(rows(beforeAccept, "versions")) != 2 || len(rows(beforeAccept, "objects")) != 2 || len(rows(beforeAccept, "receipts")) != 2 {
		t.Fatal("Submitted publication failed real D1/R2 convergence")
	}
	for _, object := range rows(beforeAccept, "objects") {
		if object["content_hash"] != expectedHash || object["size"] != float64(len(original)) {
			t.Fatal("Submitted publication changed immutable snapshot bytes")
		}
	}
	fixture.post("/api/v1/workspaces/"+fixture.ids()["workspace"]+"/runs/"+fixture.ids()["run"]+"/review", map[string]any{
		"request_id": "native-artifact-human-accept", "decision": "accept", "submission_id": submitted["submission_id"],
		"expected_run_version": submitted["run_version"], "expected_task_version": submitted["task_version"],
	}, true)
	writeFile(file, "changed after human acceptance")
	if _, code := fixture.call("bfb_publish_artifact", "native-artifact-001", params(file)); code != "capability_closed" {
		t.Fatal("human acceptance failed to precede cached conflict/private delivery", code)
	}
	writeFile(file, original)
	if _, code, status := cli("native-artifact-001", file); code != "capability_closed" || status != 3 {
		t.Fatal("fresh bound CLI bypassed accepted result", code, status)
	}
	afterAccept := observe()
	if string(beforeAccept["operations"]) != string(afterAccept["operations"]) || string(beforeAccept["versions"]) != string(afterAccept["versions"]) {
		t.Fatal("accepted denial changed canonical publication facts")
	}
	noJournal()
	for _, phase := range []string{"artifact-prepare", "artifact-upload", "artifact-finalize"} {
		fixture.freshScope(true)
		start(phase)
		fixture.loseReply.Store(&phase)
		id := "native-loss-" + phase
		if _, code := fixture.call("bfb_publish_artifact", id, params(file)); code != "work_unavailable" {
			t.Fatal("lost committed artifact phase looked definitive", phase, code)
		}
		state := "uploading"
		if phase == "artifact-finalize" {
			state = "available"
		}
		before := singleEffect(state)
		if phase != "artifact-prepare" {
			verifyBytes(before)
		}
		fixture.stopMCP()
		requestsBefore, uploadsBefore := fixture.businessRequests.Load(), fixture.uploads.Load()
		fixture.restartDaemon()
		timer := time.NewTimer(4200 * time.Millisecond)
		select {
		case <-timer.C:
		case <-fixture.ctx.Done():
			timer.Stop()
			t.Fatal("artifact no-autoreplay observation cancelled")
		}
		if fixture.businessRequests.Load() != requestsBefore || fixture.uploads.Load() != uploadsBefore {
			t.Fatal("artifact auto-recovered without explicit invocation", phase)
		}
		result, code, status := cli(id, file)
		check(result, code)
		if status != 0 {
			t.Fatal("fresh CLI explicit recovery failed", phase, status)
		}
		verifyBytes(singleEffect("available"))
		fixture.restart("__start")
		result, code = fixture.call("bfb_publish_artifact", id, params(file))
		check(result, code)
		if result["version_id"] != rows(before, "versions")[0]["id"] {
			t.Fatal("lost response created another version", phase)
		}
	}
	fixture.freshScope(true)
	start("offline")
	fixture.outage.Store(true)
	requestsBefore := fixture.businessRequests.Load()
	if _, code := fixture.call("bfb_publish_artifact", "native-artifact-offline", params(file)); code != "work_unavailable" {
		t.Fatal("offline artifact queued or delivered", code)
	}
	if _, code, status := cli("native-artifact-offline", file); code != "work_unavailable" || status != 4 {
		t.Fatal("offline bound CLI not visible", code, status)
	}
	noJournal()
	fixture.stopMCP()
	fixture.restartDaemon()
	fixture.outage.Store(false)
	timer := time.NewTimer(4200 * time.Millisecond)
	select {
	case <-timer.C:
	case <-fixture.ctx.Done():
		timer.Stop()
		t.Fatal("offline artifact observation cancelled")
	}
	if fixture.businessRequests.Load() != requestsBefore || len(rows(observe(), "operations")) != 0 {
		t.Fatal("offline artifact automatically sent after restart")
	}
	result, code, status = cli("native-artifact-offline", file)
	check(result, code)
	if status != 0 {
		t.Fatal("explicit offline retry unavailable", status)
	}
	verifyBytes(singleEffect("available"))
	fixture.restart("__start")
	// Release a genuine held lock only after real finalization, then withhold
	// its private response without rewriting the canonical available state.
	fixture.freshScope(true)
	start("postflight")
	fixture.postflightRelease("artifact-finalize")
	if _, code := fixture.call("bfb_publish_artifact", "native-artifact-postflight", params(file)); code != "assignment_ended" {
		t.Fatal("post-commit artifact ownership denial lost", code)
	}
	verifyBytes(singleEffect("available"))
	for _, closure := range []struct{ kind, code string }{{"session", "capability_closed"}, {"end", "assignment_ended"}, {"lease", "capability_closed"}, {"grant", "revoked"}} {
		fixture.freshScope(false)
		start(closure.kind)
		id := "native-artifact-closure-" + closure.kind
		result, code := fixture.call("bfb_publish_artifact", id, params(file))
		check(result, code)
		fixture.post("/__a01/change", map[string]string{"execution": fixture.ids()["execution"], "kind": closure.kind}, false)
		writeFile(file, "changed hidden outcome")
		if _, code := fixture.call("bfb_publish_artifact", id, params(file)); code != closure.code {
			t.Fatal("artifact conflict preceded current authority", closure.kind, code)
		}
		if _, code := fixture.call("bfb_publish_artifact", id, params("same-bytes.md")); code != "capability_closed" {
			t.Fatal("artifact terminal denial not sticky", closure.kind, code)
		}
		singleEffect("available")
	}
	t.Log("V01_NATIVE_PROOF_COMPLETE")
}

// ABOUTME: Serves JSON-RPC on stdio with stdout purity: responses only, diagnostics on stderr.
// ABOUTME: Fails every request visibly when startup verification cannot build a capability.

package localmcp

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"strings"

	"github.com/qdis/bfb/internal/protocol"
)

const (
	protocolVersion = "2025-11-25"
	serverName      = "bfb-local-mcp"
	contractVersion = "local-mcp/2"
	maxStdioLine    = 65536
)

// ScopedEnv carries the nine scoped BFB_* execution values plus the daemon UID.
// It never carries a cloud bearer credential; parsing refuses bearer-like extras.
type ScopedEnv struct {
	WorkspaceID  string
	ProjectID    string
	TaskID       string
	RunID        string
	ExecutionID  string
	Generation   int64
	CheckoutID   string
	Correlation  string
	ArtifactsDir string
	RunnerID     string
	DaemonUID    int
}

// ParseEnv extracts the scoped execution environment. Unknown BFB_* values are
// ignored except bearer-like names (BFB_*TOKEN, BFB_*SECRET, BFB_*BEARER,
// BFB_*KEY), which refuse startup so a cloud credential can never hide in the
// provider environment.
func ParseEnv(environ []string, daemonUID int) (ScopedEnv, error) {
	allowed := map[string]bool{
		"BFB_WORKSPACE_ID": true, "BFB_PROJECT_ID": true, "BFB_TASK_ID": true,
		"BFB_RUN_ID": true, "BFB_RUN_EXECUTION_ID": true, "BFB_ASSIGNMENT_GENERATION": true,
		"BFB_CHECKOUT_ID": true, "BFB_CORRELATION_TOKEN": true, "BFB_ARTIFACTS_DIR": true,
		"BFB_RUNNER_ID": true,
	}
	values := make(map[string]string)
	for _, entry := range environ {
		key, value, _ := strings.Cut(entry, "=")
		if !strings.HasPrefix(key, "BFB_") {
			continue
		}
		if allowed[key] {
			values[key] = value
			continue
		}
		// BFB_CORRELATION_TOKEN above is the only token the server reads.
		// Any other bearer-like variable refuses startup so a cloud
		// credential can never hide in the provider environment.
		core := strings.TrimPrefix(key, "BFB_")
		if strings.HasSuffix(core, "TOKEN") || strings.HasSuffix(core, "SECRET") ||
			strings.HasSuffix(core, "BEARER") || strings.HasSuffix(core, "KEY") {
			return ScopedEnv{}, fail("invalid_request")
		}
	}
	env := ScopedEnv{
		WorkspaceID:  values["BFB_WORKSPACE_ID"],
		ProjectID:    values["BFB_PROJECT_ID"],
		TaskID:       values["BFB_TASK_ID"],
		RunID:        values["BFB_RUN_ID"],
		ExecutionID:  values["BFB_RUN_EXECUTION_ID"],
		CheckoutID:   values["BFB_CHECKOUT_ID"],
		Correlation:  values["BFB_CORRELATION_TOKEN"],
		ArtifactsDir: values["BFB_ARTIFACTS_DIR"],
		RunnerID:     values["BFB_RUNNER_ID"],
		DaemonUID:    daemonUID,
	}
	for _, id := range []string{env.WorkspaceID, env.ProjectID, env.TaskID, env.RunID, env.ExecutionID, env.CheckoutID} {
		if !idPattern.MatchString(id) {
			return ScopedEnv{}, fail("invalid_request")
		}
	}
	if env.RunnerID != "" && !idPattern.MatchString(env.RunnerID) {
		return ScopedEnv{}, fail("invalid_request")
	}
	generation, ok := values["BFB_ASSIGNMENT_GENERATION"]
	if !ok || generation == "" {
		return ScopedEnv{}, fail("invalid_request")
	}
	var parsed int64
	for _, digit := range generation {
		if digit < '0' || digit > '9' {
			return ScopedEnv{}, fail("invalid_request")
		}
		parsed = parsed*10 + int64(digit-'0')
		if parsed > 1<<62 {
			return ScopedEnv{}, fail("invalid_request")
		}
	}
	if parsed < 1 {
		return ScopedEnv{}, fail("invalid_request")
	}
	env.Generation = parsed
	if len(env.Correlation) == 0 || len(env.Correlation) > 512 {
		return ScopedEnv{}, fail("invalid_request")
	}
	if env.ArtifactsDir == "" {
		return ScopedEnv{}, fail("invalid_request")
	}
	return env, nil
}

// Deps wires one stdio server. Every field except Journal and Now is required;
// Journal nil means offline writes fail visibly instead of journaling.
type Deps struct {
	Env         ScopedEnv
	Inspector   Inspector
	Assignments AssignmentSource
	Bindings    SessionBindingSource
	Authority   AuthoritySource
	Transport   WorkTransport
	Journal     Journal
	Policy      OfflinePolicy
	Principal   string
	Grant       string
	Stderr      io.Writer
}

// Server owns one stdio connection from startup verification to EOF.
type Server struct {
	deps        Deps
	host        *Host
	capability  *Capability
	startupErr  error
	stats       map[string]int
	initialized bool
	ready       bool
}

// NewServer verifies peer, assignment, and correlation, then builds the
// provisional capability. Verification failures do not stop the loop: the
// server answers every request with the bounded startup failure so the
// provider sees a visible error instead of a hung pipe.
func NewServer(ctx context.Context, deps Deps) *Server {
	server := &Server{deps: deps, stats: make(map[string]int)}
	if deps.Stderr == nil {
		server.deps.Stderr = os.Stderr
	}
	boundary, err := VerifyStartup(ctx, deps.Env, deps.Inspector, deps.Assignments)
	if err != nil {
		server.startupErr = err
		server.diagnose("startup error=" + CodeOf(err))
		return server
	}
	server.capability = NewCapability(boundary, deps.Bindings, deps.Authority)
	server.diagnose("verified provisional")
	principal := deps.Principal
	if principal == "" {
		principal = "agent_run:" + boundary.RunID
	}
	grant := deps.Grant
	if grant == "" {
		grant = "runner:" + boundary.RunnerID
	}
	server.host = NewHost(HostDeps{
		Capability: server.capability,
		Transport:  deps.Transport,
		Journal:    deps.Journal,
		Policy:     deps.Policy,
		Principal:  principal,
		Grant:      grant,
	})
	return server
}

// VerifyStartup shares the read-only local peer and execution checks with the
// one-shot CLI. It does not activate a session or invent cloud confirmation.
func VerifyStartup(ctx context.Context, env ScopedEnv, inspector Inspector, assignments AssignmentSource) (Boundary, error) {
	if assignments == nil || inspector == nil {
		return Boundary{}, fail("assignment_unknown")
	}
	assignment, err := assignments.Lookup(ctx, env.ExecutionID, env.Generation)
	if err != nil || assignment.Boundary.ExecutionID != env.ExecutionID || assignment.Boundary.Generation != env.Generation ||
		assignment.Boundary.RunID != env.RunID || assignment.Boundary.TaskID != env.TaskID || assignment.Boundary.ProjectID != env.ProjectID || assignment.Boundary.WorkspaceID != env.WorkspaceID ||
		assignment.Boundary.CheckoutID != env.CheckoutID || (env.RunnerID != "" && assignment.Boundary.RunnerID != env.RunnerID) {
		return Boundary{}, fail("assignment_unknown")
	}
	facts, err := inspector.Inspect()
	if err != nil {
		return Boundary{}, err
	}
	if err := VerifyPeer(facts, env.DaemonUID, assignment, env.Correlation); err != nil {
		return Boundary{}, err
	}
	return assignment.Boundary, nil
}

type wireRequest struct {
	JSONRPC string         `json:"jsonrpc"`
	Method  string         `json:"method"`
	ID      any            `json:"id"`
	Params  map[string]any `json:"params"`
}

// Serve runs the stdio loop until EOF or context cancellation. Stdout carries
// JSON-RPC values only; every diagnostic goes to stderr. It returns the
// process exit code.
func (server *Server) Serve(ctx context.Context, stdin io.Reader, stdout io.Writer) int {
	reader := bufio.NewReaderSize(stdin, maxStdioLine)
	writer := bufio.NewWriter(stdout)
	defer writer.Flush()
	for {
		select {
		case <-ctx.Done():
			server.close()
			return 0
		default:
		}
		line, err := reader.ReadBytes('\n')
		if err != nil {
			server.close()
			server.diagnose("closed")
			return 0
		}
		if len(line) > maxStdioLine {
			server.writeError(writer, nil, fail("request_rejected"))
			server.note("oversize")
			continue
		}
		server.serveLine(ctx, writer, line)
	}
}

func (server *Server) close() {
	if server.capability != nil {
		server.capability.Close()
	}
}

func (server *Server) serveLine(ctx context.Context, writer *bufio.Writer, line []byte) {
	trimmed := strings.TrimSpace(string(line))
	if trimmed == "" {
		return
	}
	var request wireRequest
	decoder := json.NewDecoder(strings.NewReader(trimmed))
	decoder.UseNumber()
	if err := decoder.Decode(&request); err != nil {
		server.writeError(writer, nil, fail("parse_error"))
		server.note("parse_error")
		return
	}
	if request.JSONRPC != "2.0" || request.Method == "" {
		server.writeError(writer, request.ID, fail("invalid_request"))
		server.note("invalid_request")
		return
	}
	if request.ID == nil {
		if request.Method == "notifications/initialized" && server.initialized {
			server.ready = true
		}
		return
	}
	// A failed startup verification fails the handshake itself: the client
	// must not proceed against a server with no verified run boundary.
	if server.startupErr != nil && (request.Method == "initialize" || request.Method == "tools/list" || request.Method == "tools/call") {
		server.writeError(writer, request.ID, server.startupErr)
		server.note(CodeOf(server.startupErr))
		return
	}
	switch request.Method {
	case "initialize":
		if server.initialized {
			server.writeError(writer, request.ID, fail("invalid_request"))
			return
		}
		version, _ := request.Params["protocolVersion"].(string)
		_, capabilitiesOK := request.Params["capabilities"].(map[string]any)
		client, _ := request.Params["clientInfo"].(map[string]any)
		name, _ := client["name"].(string)
		clientVersion, _ := client["version"].(string)
		if version == "" || !capabilitiesOK || name == "" || clientVersion == "" {
			server.writeError(writer, request.ID, fail("invalid_params"))
			return
		}
		// This server supports one handshake-era revision. A different request
		// gets that counteroffer; it never switches to the modern lifecycle.
		server.initialized = true
		server.writeResult(writer, request.ID, map[string]any{
			"protocolVersion": protocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": serverName, "version": contractVersion},
		})
	case "ping":
		server.writeResult(writer, request.ID, map[string]any{})
	case "tools/list":
		if !server.ready {
			server.writeError(writer, request.ID, fail("invalid_request"))
			return
		}
		server.writeResult(writer, request.ID, map[string]any{"tools": ToolDescriptors()})
	case "tools/call":
		if !server.ready {
			server.writeError(writer, request.ID, fail("invalid_request"))
			return
		}
		server.serveCall(ctx, writer, request)
	default:
		server.writeError(writer, request.ID, fail("method_not_found"))
		server.note("method_not_found")
	}
}

func (server *Server) serveCall(ctx context.Context, writer *bufio.Writer, request wireRequest) {
	if server.startupErr != nil {
		server.writeError(writer, request.ID, server.startupErr)
		server.note(CodeOf(server.startupErr))
		return
	}
	name, _ := request.Params["name"].(string)
	rawArgs, _ := request.Params["arguments"].(map[string]any)
	if name == "" || rawArgs == nil {
		server.writeError(writer, request.ID, fail("invalid_params"))
		server.note("invalid_params")
		return
	}
	// Validate exact progress and expected-version lexemes before converting
	// accepted values to the tools' canonical float64 representation.
	rawArgs = normalizeNumbers(name, rawArgs)
	result, err := server.host.CallTool(ctx, name, rawArgs)
	if err != nil {
		server.writeError(writer, request.ID, err)
		server.note(CodeOf(err))
		return
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		server.writeError(writer, request.ID, fail("internal_error"))
		server.note("internal_error")
		return
	}
	server.writeResult(writer, request.ID, map[string]any{
		"content": []map[string]any{{"type": "text", "text": string(encoded)}},
	})
	server.note("ok")
}

// normalizeNumbers validates progress metadata and update versions before
// canonicalizing equivalent spellings; invalid raw values remain for rejection.
func normalizeNumbers(tool string, args map[string]any) map[string]any {
	normalized := make(map[string]any, len(args))
	for key, value := range args {
		if tool == "bfb_report_progress" && (key == "percent" || key == "confidence") {
			if parsed, valid := progressNumber(key, value); valid {
				normalized[key] = parsed
			} else {
				normalized[key] = value
			}
			continue
		}
		if number, ok := value.(json.Number); ok {
			if tool == "bfb_update_task" && key == "expected_version" {
				if parsed, valid := protocol.ParseWireInteger(number.String()); valid {
					normalized[key] = float64(parsed)
				} else {
					normalized[key] = value
				}
				continue
			}
			if parsed, err := number.Float64(); err == nil {
				normalized[key] = parsed
				continue
			}
		}
		normalized[key] = value
	}
	return normalized
}

func (server *Server) writeResult(writer *bufio.Writer, id any, result any) {
	envelope := map[string]any{"jsonrpc": "2.0", "id": id, "result": result}
	data, err := json.Marshal(envelope)
	if err != nil {
		return
	}
	_, _ = writer.Write(append(data, '\n'))
	_ = writer.Flush()
}

func (server *Server) writeError(writer *bufio.Writer, id any, err error) {
	code := CodeOf(err)
	numeric, message := jsonRPCCode(code)
	envelope := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error": map[string]any{
			"code":    numeric,
			"message": message,
			"data":    map[string]any{"bfb_code": code},
		},
	}
	data, marshalErr := json.Marshal(envelope)
	if marshalErr != nil {
		return
	}
	_, _ = writer.Write(append(data, '\n'))
	_ = writer.Flush()
}

// diagnose writes one bounded line to stderr. It carries the failure code or
// lifecycle event only; request content, environment, and bodies never appear.
func (server *Server) diagnose(event string) {
	_, _ = server.deps.Stderr.Write([]byte("bfb mcp stdio: " + event + "\n"))
}

func (server *Server) note(code string) {
	server.stats[code]++
	server.diagnose("error=" + code)
}

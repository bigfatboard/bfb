// ABOUTME: Defines bounded local MCP failures without echoing secrets, bodies, or environment values.
// ABOUTME: Maps each failure to a JSON-RPC error code, message, and MCP diagnostic code.

package localmcp

// Error is a bounded local MCP failure. Only Code crosses the stdio boundary.
type Error struct{ Code string }

func (err *Error) Error() string { return "localmcp: " + err.Code }

func fail(code string) *Error { return &Error{Code: code} }

// CodeOf extracts the bounded failure code from any error.
func CodeOf(err error) string {
	if failure, ok := err.(*Error); ok && failure != nil {
		return failure.Code
	}
	return "internal_error"
}

type jsonRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    *struct {
		BFBCode string `json:"bfb_code"`
	} `json:"data,omitempty"`
}

// jsonRPCCode maps a bounded failure to a JSON-RPC numeric code and message.
// Messages are fixed strings; they never echo request content.
func jsonRPCCode(code string) (int, string) {
	switch code {
	case "parse_error":
		return -32700, "The JSON-RPC payload is malformed."
	case "invalid_request":
		return -32600, "The JSON-RPC request is invalid."
	case "method_not_found":
		return -32601, "This MCP method is not part of local-mcp/1."
	case "invalid_params":
		return -32602, "The tool arguments are invalid."
	case "peer_denied":
		return -32001, "The local process is not the assigned provider process."
	case "assignment_unknown":
		return -32002, "No active local execution assignment matches this server."
	case "assignment_ended":
		return -32003, "The local execution has ended."
	case "correlation_rejected":
		return -32004, "The correlation value does not match the assignment."
	case "session_not_bound":
		return -32005, "No trusted provider session is bound yet; mutations are rejected."
	case "session_conflict":
		return -32006, "A different provider session already owns this connection."
	case "boundary_escape":
		return -32007, "The supplied identifier is outside the run boundary."
	case "capability_closed":
		return -32008, "The run capability is closed."
	case "revoked":
		return -32009, "Current authority revoked this run capability."
	case "stale_version":
		return -32010, "The expected resource version does not match current state."
	case "forbidden":
		return -32011, "The run capability cannot perform this action."
	case "policy_rejected":
		return -32012, "Effective project policy rejects this action."
	case "offline_rejected":
		return -32013, "The cloud channel is unreachable and policy forbids queueing."
	case "not_found":
		return -32014, "The referenced record is not visible to this run."
	case "request_rejected":
		return -32015, "The request exceeds a local bound."
	case "not_implemented":
		return -32016, "This tool belongs to a later package on the same server."
	default:
		return -32603, "The local operation failed."
	}
}

// ABOUTME: Speaks the frozen X02 control-plane surface with a bearer human credential.
// ABOUTME: Failures stay redacted; an unreachable control plane maps to a stable offline code.

package humancli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// APIVersionPath is the unauthenticated compatibility diagnostic.
const APIVersionPath = "/api/v1/cli/version"

// ServerVersion carries the compatibility diagnostic.
type ServerVersion struct {
	APIVersion    string `json:"api_version"`
	WireProtocol  string `json:"wire_protocol"`
	CLIMinVersion string `json:"cli_min_version"`
}

// Client talks to one control-plane origin as one stored human credential.
type Client struct {
	ControlURL string
	Release    string
	Credential string
	HTTP       *http.Client
}

func (c Client) http() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 30 * time.Second}
}

func (c Client) version() string {
	if c.Release != "" {
		return c.Release
	}
	return ClientVersion
}

// serverError decodes a bounded control-plane failure without trusting its shape.
type serverError struct {
	Error string `json:"error"`
}

// Do sends one authenticated JSON request and returns the decoded body.
func (c Client) Do(ctx context.Context, method, path string, body map[string]any) (int, map[string]any, *Failure) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return 0, nil, fail("internal_error", "the local operation failed")
		}
		reader = bytes.NewReader(data)
	}
	request, err := http.NewRequestWithContext(ctx, method, strings.TrimSuffix(c.ControlURL, "/")+path, reader)
	if err != nil {
		return 0, nil, fail("invalid_request", "the control origin is invalid")
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if c.Credential != "" {
		request.Header.Set("Authorization", "Bearer "+c.Credential)
	}
	request.Header.Set("X-BFB-CLI-Version", c.version())
	request.Header.Set("Accept", "application/json")
	response, err := c.http().Do(request)
	if err != nil {
		return 0, nil, fail("control_unreachable", "the control plane is not reachable")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return 0, nil, fail("control_unreachable", "the control plane is not reachable")
	}
	decoded := map[string]any{}
	if len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, &decoded); err != nil {
			return 0, nil, fail("request_failed", "the control plane answered outside the frozen surface")
		}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		code := "request_failed"
		if rawErr, ok := decoded["error"].(string); ok && rawErr != "" {
			code = sanitizeCode(rawErr)
		}
		return response.StatusCode, nil, &Failure{Code: code, Message: messageFor(code)}
	}
	return response.StatusCode, decoded, nil
}

// Version fetches the unauthenticated compatibility diagnostic.
func (c Client) Version(ctx context.Context) (ServerVersion, *Failure) {
	_, body, failure := c.Do(ctx, http.MethodGet, APIVersionPath, nil)
	if failure != nil {
		return ServerVersion{}, failure
	}
	version := ServerVersion{}
	if value, ok := body["api_version"].(string); ok {
		version.APIVersion = value
	}
	if value, ok := body["wire_protocol"].(string); ok {
		version.WireProtocol = value
	}
	if value, ok := body["cli_min_version"].(string); ok {
		version.CLIMinVersion = value
	}
	if version.APIVersion == "" {
		return ServerVersion{}, fail("request_failed", "the control plane answered outside the frozen surface")
	}
	return version, nil
}

// CheckCompatible refuses mutations when the server API major moved past this client.
func (c Client) CheckCompatible(ctx context.Context) (ServerVersion, *Failure) {
	version, failure := c.Version(ctx)
	if failure != nil {
		return version, failure
	}
	if major(version.APIVersion) > major(MinAPIVersion) || major(version.APIVersion) < 1 {
		return version, fail("version_mismatch", fmt.Sprintf(
			"server API %s is outside this client's supported major %s; upgrade bfb", version.APIVersion, MinAPIVersion))
	}
	return version, nil
}

func major(version string) int {
	number := 0
	_, _ = fmt.Sscanf(strings.TrimSpace(version), "%d", &number)
	return number
}

// sanitizeCode keeps only safe diagnostic codes; everything else fails closed.
func sanitizeCode(code string) string {
	if code == "" || len(code) > 64 {
		return "request_failed"
	}
	for _, char := range code {
		if (char < 'a' || char > 'z') && char != '_' {
			return "request_failed"
		}
	}
	return code
}

// messageFor renders fixed user-facing text so server prose never reaches output.
func messageFor(code string) string {
	switch code {
	case "unauthenticated":
		return "no active CLI credential; run bfb login"
	case "credential_confusion":
		return "this credential is not accepted on that route"
	case "forbidden", "request_rejected":
		return "the current credential is not permitted to do that"
	case "not_found":
		return "no such object is visible to this credential"
	case "stale_version":
		return "the object changed; reread it and retry with the current version"
	case "already_answered":
		return "the request already carries an answer; reread it"
	case "step_up_invalid", "step_up_stale", "step_up_mismatch", "step_up_replayed", "step_up_unauthenticated":
		return "the fresh proof is missing, expired, or bound to another action; redo the browser step-up"
	case "invalid_argument", "invalid_json", "body_too_large":
		return "the local request is invalid"
	default:
		return "the control plane rejected the request"
	}
}

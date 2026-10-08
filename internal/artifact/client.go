// ABOUTME: Publishes review artifacts through typed create, upload, and finalize calls.
// ABOUTME: Callers supply bytes and metadata only; the R2 key is always server-derived.

package artifact

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
)

// ReviewMaxBytes bounds review artifact uploads. LogMaxBytes bounds log chunks.
const (
	ReviewMaxBytes = 5 * 1024 * 1024
	LogMaxBytes    = 1 * 1024 * 1024
)

// Error is a typed publish failure without secrets, bytes, or digests.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Auth carries the caller's opaque credential. The daemon loads it from a
// private file; it never appears in process arguments or diagnostics.
type Auth struct {
	Cookie string
	Bearer string
}

// Client talks to the Control Worker (grants/finalize) and Artifact Worker (bytes).
type Client struct {
	ControlURL   string
	ArtifactsURL string
	HTTP         *http.Client
	Auth         Auth
}

// Params describes one logical publication. R2 keys are never caller inputs.
type Params struct {
	WorkspaceID string
	ArtifactID  string
	RunID       string
	Format      string
	Role        string
}

// Grant is a one-time upload authorization returned once at creation.
type Grant struct {
	ID        string
	VersionID string
	Secret    string
	ExpiresAt string
}

// Created is a new uploading version plus its single-use grant.
type Created struct {
	ArtifactID string
	VersionID  string
	Grant      Grant
}

// Published is a finalized available version.
type Published struct {
	ArtifactID   string
	VersionID    string
	ContentHash  string
	Size         int64
	R2Key        string
	Deduplicated bool
}

var formats = map[string]bool{
	"markdown": true, "mermaid": true, "diff": true, "svg": true,
	"png": true, "jpeg": true, "html": true, "log": true, "json": true,
}

var roles = map[string]bool{"review": true, "log": true}

func roleCap(role string) int64 {
	if role == "log" {
		return LogMaxBytes
	}
	return ReviewMaxBytes
}

func checkParams(params Params) error {
	if params.WorkspaceID == "" || !formats[params.Format] || !roles[params.Role] {
		return &Error{Code: "invalid_request", Message: "artifact params are invalid"}
	}
	return nil
}

func (c *Client) http() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

func (c *Client) applyAuth(request *http.Request) {
	if c.Auth.Cookie != "" {
		request.AddCookie(&http.Cookie{Name: "__Host-bfb_session", Value: c.Auth.Cookie})
	}
	if c.Auth.Bearer != "" {
		request.Header.Set("Authorization", "Bearer "+c.Auth.Bearer)
	}
}

func base(rawurl, name string) (string, error) {
	parsed, err := url.Parse(rawurl)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" {
		return "", &Error{Code: "invalid_request", Message: name + " is not a valid origin"}
	}
	return strings.TrimSuffix(rawurl, "/"), nil
}

type serverError struct {
	Err     string `json:"error"`
	Message string `json:"message"`
}

func fail(status int, body []byte) error {
	var decoded serverError
	if err := json.Unmarshal(body, &decoded); err != nil || decoded.Err == "" {
		if status == http.StatusUnauthorized {
			return &Error{Code: "unauthorized", Message: "artifact authorization failed"}
		}
		if status >= 500 {
			return &Error{Code: "unavailable", Message: "artifact service is unavailable"}
		}
		return &Error{Code: "request_rejected", Message: "artifact request was rejected"}
	}
	switch status {
	case http.StatusUnauthorized:
		return &Error{Code: "unauthorized", Message: decoded.Err}
	case http.StatusForbidden:
		return &Error{Code: "request_rejected", Message: decoded.Err}
	case http.StatusRequestEntityTooLarge:
		return &Error{Code: "too_large", Message: decoded.Err}
	case http.StatusUnprocessableEntity:
		return &Error{Code: "upload_rejected", Message: decoded.Message}
	case http.StatusConflict:
		return &Error{Code: "upload_conflict", Message: decoded.Err}
	default:
		if status >= 500 {
			return &Error{Code: "unavailable", Message: decoded.Err}
		}
		return &Error{Code: "request_rejected", Message: decoded.Err}
	}
}

func postJSON(ctx context.Context, client *http.Client, target string, auth Auth, payload map[string]any) ([]byte, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, &Error{Code: "invalid_request", Message: "artifact payload is invalid"}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(encoded))
	if err != nil {
		return nil, &Error{Code: "invalid_request", Message: "artifact request is invalid"}
	}
	request.Header.Set("Content-Type", "application/json")
	tmp := Client{Auth: auth}
	tmp.applyAuth(request)
	response, err := client.Do(request)
	if err != nil {
		return nil, &Error{Code: "unavailable", Message: "artifact service is unavailable"}
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if err != nil {
		return nil, &Error{Code: "unavailable", Message: "artifact response failed"}
	}
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusCreated {
		return nil, fail(response.StatusCode, body)
	}
	return body, nil
}

// Prepare reads bounded file bytes and computes the SHA-256 digest the server verifies.
func Prepare(path, role string) ([]byte, string, error) {
	cap := roleCap(role)
	file, err := os.Open(path)
	if err != nil {
		return nil, "", &Error{Code: "invalid_request", Message: "artifact file cannot be opened"}
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, "", &Error{Code: "invalid_request", Message: "artifact path is not a file"}
	}
	if info.Size() > cap {
		return nil, "", &Error{Code: "too_large", Message: "artifact file exceeds the role limit"}
	}
	content, err := io.ReadAll(io.LimitReader(file, cap+1))
	if err != nil {
		return nil, "", &Error{Code: "unavailable", Message: "artifact file cannot be read"}
	}
	if int64(len(content)) > cap {
		return nil, "", &Error{Code: "too_large", Message: "artifact file exceeds the role limit"}
	}
	sum := sha256.Sum256(content)
	return content, hex.EncodeToString(sum[:]), nil
}

// Create opens an uploading version and returns its one-time upload grant.
func (c *Client) Create(ctx context.Context, params Params, size int64, digest string) (*Created, error) {
	if err := checkParams(params); err != nil {
		return nil, err
	}
	control, err := base(c.ControlURL, "control URL")
	if err != nil {
		return nil, err
	}
	payload := map[string]any{
		"format": params.Format, "role": params.Role,
		"declared_size": size, "expected_digest": digest,
	}
	if params.ArtifactID != "" {
		payload["artifact_id"] = params.ArtifactID
	}
	if params.RunID != "" {
		payload["run_id"] = params.RunID
	}
	body, err := postJSON(ctx, c.http(), control+"/api/v1/workspaces/"+params.WorkspaceID+"/artifacts", c.Auth, payload)
	if err != nil {
		return nil, err
	}
	var decoded struct {
		ArtifactID string `json:"artifact_id"`
		VersionID  string `json:"version_id"`
		Grant      struct {
			ID        string `json:"grant_id"`
			VersionID string `json:"version_id"`
			Secret    string `json:"secret"`
			ExpiresAt string `json:"expires_at"`
		} `json:"upload_grant"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil || decoded.VersionID == "" || decoded.Grant.Secret == "" {
		return nil, &Error{Code: "unavailable", Message: "artifact creation response is invalid"}
	}
	return &Created{
		ArtifactID: decoded.ArtifactID,
		VersionID:  decoded.VersionID,
		Grant: Grant{
			ID: decoded.Grant.ID, VersionID: decoded.Grant.VersionID,
			Secret: decoded.Grant.Secret, ExpiresAt: decoded.Grant.ExpiresAt,
		},
	}, nil
}

// Upload streams bytes against a consumed-once grant. The grant secret travels
// only in the Authorization header, never in a URL, log, or stored payload.
func (c *Client) Upload(ctx context.Context, grant Grant, content []byte) error {
	origin, err := base(c.ArtifactsURL, "artifacts URL")
	if err != nil {
		return err
	}
	if grant.ID == "" || grant.Secret == "" {
		return &Error{Code: "invalid_request", Message: "upload grant is invalid"}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, origin+"/upload/"+grant.ID, bytes.NewReader(content))
	if err != nil {
		return &Error{Code: "invalid_request", Message: "upload request is invalid"}
	}
	request.Header.Set("Authorization", "Bearer "+grant.Secret)
	request.Header.Set("Content-Type", "application/octet-stream")
	response, err := c.http().Do(request)
	if err != nil {
		return &Error{Code: "unavailable", Message: "artifact upload failed"}
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if err != nil {
		return &Error{Code: "unavailable", Message: "artifact upload response failed"}
	}
	if response.StatusCode != http.StatusOK {
		return fail(response.StatusCode, body)
	}
	return nil
}

// Finalize moves an uploaded version to available after the verified receipt exists.
func (c *Client) Finalize(ctx context.Context, workspaceID, versionID, digest string, size int64) (*Published, error) {
	control, err := base(c.ControlURL, "control URL")
	if err != nil {
		return nil, err
	}
	if workspaceID == "" || versionID == "" {
		return nil, &Error{Code: "invalid_request", Message: "finalize target is invalid"}
	}
	body, err := postJSON(ctx, c.http(), control+"/api/v1/workspaces/"+workspaceID+"/artifacts/"+versionID+"/finalize", c.Auth, map[string]any{
		"content_hash": digest, "size": size,
	})
	if err != nil {
		return nil, err
	}
	var decoded struct {
		ArtifactID string `json:"artifact_id"`
		VersionID  string `json:"version_id"`
		R2Key      string `json:"r2_key"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil || decoded.R2Key == "" {
		return nil, &Error{Code: "unavailable", Message: "artifact finalize response is invalid"}
	}
	return &Published{
		ArtifactID: decoded.ArtifactID, VersionID: decoded.VersionID,
		ContentHash: digest, Size: size, R2Key: decoded.R2Key,
	}, nil
}

// Publish runs create, upload, and finalize for in-memory bytes.
func (c *Client) Publish(ctx context.Context, params Params, content []byte) (*Published, error) {
	if err := checkParams(params); err != nil {
		return nil, err
	}
	if int64(len(content)) < 1 || int64(len(content)) > roleCap(params.Role) {
		return nil, &Error{Code: "too_large", Message: "artifact bytes exceed the role limit"}
	}
	sum := sha256.Sum256(content)
	digest := hex.EncodeToString(sum[:])
	created, err := c.Create(ctx, params, int64(len(content)), digest)
	if err != nil {
		return nil, err
	}
	if err := c.Upload(ctx, created.Grant, content); err != nil {
		return nil, err
	}
	published, err := c.Finalize(ctx, params.WorkspaceID, created.VersionID, digest, int64(len(content)))
	if err != nil {
		return nil, err
	}
	published.ArtifactID = created.ArtifactID
	return published, nil
}

// PublishFile reads a local file and runs the full publication state machine.
func (c *Client) PublishFile(ctx context.Context, params Params, path string) (*Published, error) {
	if err := checkParams(params); err != nil {
		return nil, err
	}
	content, _, err := Prepare(path, params.Role)
	if err != nil {
		return nil, err
	}
	return c.Publish(ctx, params, content)
}

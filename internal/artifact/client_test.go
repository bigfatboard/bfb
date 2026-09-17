// ABOUTME: Verifies the typed publish client against fake Control and Artifact origins.
// ABOUTME: Synthetic doubles prove error mapping, digest computation, and keyless requests.

package artifact

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var syntheticContent = []byte("# synthetic review\n")

const (
	testWorkspace = "01JBFB0W0RKSPACE0000000000"
	testArtifact  = "01JBFB0ART1FACT01000000000"
	testVersion   = "01JBFB0VERS10N010000000000"
	testGrant     = "01JBFB0GRANT0100000000000"
)

func syntheticDigest() string {
	sum := sha256.Sum256(syntheticContent)
	return hex.EncodeToString(sum[:])
}

type fakeOrigins struct {
	t            *testing.T
	controlHits  int
	createBody   map[string]any
	uploadAuth   string
	uploadTarget string
	uploadBody   []byte
	createStatus int
	createExtra  map[string]any
	uploadStatus int
	uploadExtra  map[string]any
	finalStatus  int
	secret       string
}

func startFakes(t *testing.T, fake *fakeOrigins) (*httptest.Server, *httptest.Server) {
	t.Helper()
	fake.t = t
	control := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		fake.controlHits++
		body, _ := io.ReadAll(request.Body)
		if strings.HasSuffix(request.URL.Path, "/finalize") {
			var decoded map[string]any
			if err := json.Unmarshal(body, &decoded); err != nil {
				t.Error("finalize body is not JSON")
			}
			if decoded["content_hash"] != syntheticDigest() {
				t.Errorf("finalize carried wrong digest: %v", decoded["content_hash"])
			}
			status := fake.finalStatus
			if status == 0 {
				status = http.StatusOK
			}
			if status != http.StatusOK {
				writer.WriteHeader(status)
				_ = json.NewEncoder(writer).Encode(map[string]any{"error": "request_rejected"})
				return
			}
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"artifact_id": testArtifact,
				"version_id":  testVersion,
				"r2_key":      "workspaces/" + testWorkspace + "/artifacts/sha256/" + syntheticDigest(),
			})
			return
		}
		var decoded map[string]any
		if err := json.Unmarshal(body, &decoded); err != nil {
			t.Error("create body is not JSON")
		}
		fake.createBody = decoded
		status := fake.createStatus
		if status == 0 {
			status = http.StatusCreated
		}
		if status != http.StatusCreated {
			writer.WriteHeader(status)
			_ = json.NewEncoder(writer).Encode(map[string]any{"error": "request_rejected", "message": "request rejected"})
			return
		}
		for key, value := range fake.createExtra {
			decoded[key] = value
		}
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"artifact_id": testArtifact,
			"version_id":  testVersion,
			"upload_grant": map[string]any{
				"grant_id":   testGrant,
				"version_id": testVersion,
				"secret":     fake.secret,
				"expires_at": "2026-09-17T12:15:00.000Z",
			},
		})
	}))
	artifacts := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		fake.uploadAuth = request.Header.Get("Authorization")
		fake.uploadTarget = request.URL.RequestURI()
		body, _ := io.ReadAll(request.Body)
		fake.uploadBody = body
		if request.Method != http.MethodPut {
			t.Errorf("upload used %s", request.Method)
		}
		status := fake.uploadStatus
		if status == 0 {
			status = http.StatusOK
		}
		if status != http.StatusOK {
			writer.WriteHeader(status)
			extra := map[string]any{"error": "request_rejected", "message": "request rejected"}
			for key, value := range fake.uploadExtra {
				extra[key] = value
			}
			_ = json.NewEncoder(writer).Encode(extra)
			return
		}
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"version_id": testVersion, "content_hash": syntheticDigest(),
		})
	}))
	t.Cleanup(control.Close)
	t.Cleanup(artifacts.Close)
	return control, artifacts
}

func testClient(control, artifacts *httptest.Server, fake *fakeOrigins) *Client {
	return &Client{ControlURL: control.URL, ArtifactsURL: artifacts.URL, Auth: Auth{Cookie: "synthetic-cookie"}}
}

func TestPublishHappyPath(t *testing.T) {
	fake := &fakeOrigins{secret: "synthetic-grant-secret-0123456789abcdef"}
	control, artifacts := startFakes(t, fake)
	published, err := testClient(control, artifacts, fake).Publish(context.Background(), Params{
		WorkspaceID: testWorkspace, Format: "markdown", Role: "review",
	}, syntheticContent)
	if err != nil {
		t.Fatal(err)
	}
	if published.VersionID != testVersion || published.ContentHash != syntheticDigest() {
		t.Fatalf("bad publish result: %+v", published)
	}
	if published.R2Key != "workspaces/"+testWorkspace+"/artifacts/sha256/"+syntheticDigest() {
		t.Fatalf("bad r2 key: %s", published.R2Key)
	}
	if _, ok := fake.createBody["r2_key"]; ok {
		t.Fatal("client selected an R2 key")
	}
	if _, ok := fake.createBody["r2Key"]; ok {
		t.Fatal("client selected an R2 key")
	}
	if fake.uploadAuth != "Bearer "+fake.secret {
		t.Fatalf("upload auth wrong: %q", fake.uploadAuth)
	}
	if strings.Contains(fake.uploadTarget, fake.secret) {
		t.Fatal("grant secret traveled in the URL")
	}
	if string(fake.uploadBody) != string(syntheticContent) {
		t.Fatal("upload bytes changed in flight")
	}
}

func TestPublishMapsServerFailures(t *testing.T) {
	params := Params{WorkspaceID: testWorkspace, Format: "markdown", Role: "review"}
	t.Run("create rejected", func(t *testing.T) {
		fake := &fakeOrigins{secret: "s", createStatus: http.StatusForbidden}
		control, artifacts := startFakes(t, fake)
		_, err := testClient(control, artifacts, fake).Publish(context.Background(), params, syntheticContent)
		failure, ok := err.(*Error)
		if !ok || failure.Code != "request_rejected" {
			t.Fatalf("bad mapping: %v", err)
		}
	})
	t.Run("upload content rejected", func(t *testing.T) {
		fake := &fakeOrigins{
			secret:       "s",
			uploadStatus: http.StatusUnprocessableEntity,
			uploadExtra:  map[string]any{"error": "upload_rejected", "message": "mime_mismatch"},
		}
		control, artifacts := startFakes(t, fake)
		_, err := testClient(control, artifacts, fake).Publish(context.Background(), params, syntheticContent)
		failure, ok := err.(*Error)
		if !ok || failure.Code != "upload_rejected" || failure.Message != "mime_mismatch" {
			t.Fatalf("bad mapping: %v", err)
		}
	})
	t.Run("finalize conflict", func(t *testing.T) {
		fake := &fakeOrigins{secret: "s", finalStatus: http.StatusConflict}
		control, artifacts := startFakes(t, fake)
		_, err := testClient(control, artifacts, fake).Publish(context.Background(), params, syntheticContent)
		failure, ok := err.(*Error)
		if !ok || failure.Code != "upload_conflict" {
			t.Fatalf("bad mapping: %v", err)
		}
	})
}

func TestPublishValidatesBeforeNetwork(t *testing.T) {
	fake := &fakeOrigins{secret: "s"}
	control, artifacts := startFakes(t, fake)
	client := testClient(control, artifacts, fake)
	if _, err := client.Publish(context.Background(), Params{WorkspaceID: "w", Format: "exe", Role: "review"}, syntheticContent); err == nil {
		t.Fatal("unknown format reached the network")
	}
	big := make([]byte, LogMaxBytes+1)
	if _, err := client.Publish(context.Background(), Params{WorkspaceID: "w", Format: "log", Role: "log"}, big); err == nil {
		t.Fatal("oversized log reached the network")
	}
	if _, err := client.Publish(context.Background(), Params{WorkspaceID: "w", Format: "exe", Role: "review"}, syntheticContent); err == nil {
		t.Fatal("unknown format reached the network")
	} else if _, ok := err.(*Error); !ok {
		t.Fatalf("untyped validation error: %v", err)
	}
	if fake.controlHits != 0 {
		t.Fatal("invalid input caused network traffic")
	}
}

func TestPrepareComputesDigests(t *testing.T) {
	path := filepath.Join(t.TempDir(), "review.md")
	if err := os.WriteFile(path, syntheticContent, 0600); err != nil {
		t.Fatal(err)
	}
	content, digest, err := Prepare(path, "review")
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != string(syntheticContent) || digest != syntheticDigest() {
		t.Fatal("prepare changed bytes or digest")
	}
	if _, _, err := Prepare(filepath.Join(t.TempDir(), "missing.md"), "review"); err == nil {
		t.Fatal("missing file was accepted")
	}
	big := filepath.Join(t.TempDir(), "big.md")
	if err := os.WriteFile(big, make([]byte, ReviewMaxBytes+1), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Prepare(big, "review"); err == nil {
		t.Fatal("oversized file was accepted")
	} else if failure, ok := err.(*Error); !ok || failure.Code != "too_large" {
		t.Fatalf("bad oversize code: %v", err)
	}
}

func TestPublishFileEndToEnd(t *testing.T) {
	fake := &fakeOrigins{secret: "synthetic-grant-secret-0123456789abcdef"}
	control, artifacts := startFakes(t, fake)
	path := filepath.Join(t.TempDir(), "review.md")
	if err := os.WriteFile(path, syntheticContent, 0600); err != nil {
		t.Fatal(err)
	}
	published, err := testClient(control, artifacts, fake).PublishFile(context.Background(), Params{
		WorkspaceID: testWorkspace, Format: "markdown", Role: "review",
	}, path)
	if err != nil {
		t.Fatal(err)
	}
	if published.Size != int64(len(syntheticContent)) {
		t.Fatalf("bad size: %+v", published)
	}
}

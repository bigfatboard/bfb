// ABOUTME: Verifies real artifact PUT isolation from cookie jars, runner proofs and redirects.
// ABOUTME: Exercises origin, grant, body and response bounds without any stored upload secret.

package runner

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

func TestArtifactUploadUsesOnlyOneTimeGrant(t *testing.T) {
	secret := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	grant := "01K00000000000000000000001"
	var requests atomic.Int64
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests.Add(1)
		content, _ := io.ReadAll(request.Body)
		if request.Method != "PUT" || request.URL.Path != "/upload/"+grant || request.Header.Get("Authorization") != "Bearer "+secret || string(content) != "Synthetic bytes" {
			t.Error("fixed grant upload changed")
		}
		for _, field := range []string{"Cookie", "Origin", ProofHeader} {
			if request.Header.Get(field) != "" {
				t.Error("private runner/browser credential reached artifact origin", field)
			}
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"verified":true}`))
	}))
	defer server.Close()
	enrollment, credentials := testEnrollment(t)
	client := server.Client()
	client.Jar, _ = cookiejar.New(nil)
	target, _ := url.Parse(server.URL)
	client.Jar.SetCookies(target, []*http.Cookie{{Name: "private", Value: "cookie-canary"}})
	connection, err := NewConnection(enrollment, credentials, client, func(context.Context, int64) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := connection.UploadArtifact(context.Background(), server.URL, grant, secret, []byte("Synthetic bytes")); err != nil || requests.Load() != 1 {
		t.Fatal("isolated upload failed", err)
	}
	if credentials.signs != 0 || credentials.writes != 0 {
		t.Fatal("artifact upload touched runner credentials")
	}
}

func TestArtifactUploadRefusesRedirectsAndResponseOverflow(t *testing.T) {
	var leaked atomic.Int64
	target := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { leaked.Add(1) }))
	defer target.Close()
	var overflow atomic.Bool
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if overflow.Load() {
			_, _ = writer.Write([]byte(strings.Repeat("x", 4097)))
			return
		}
		http.Redirect(writer, request, target.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	enrollment, credentials := testEnrollment(t)
	connection, err := NewConnection(enrollment, credentials, server.Client(), func(context.Context, int64) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	secret := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	if _, err := connection.UploadArtifact(context.Background(), server.URL, "01K00000000000000000000001", secret, []byte("Synthetic")); !errors.Is(err, ErrProtocol) || leaked.Load() != 0 {
		t.Fatal("upload followed redirect", err)
	}
	overflow.Store(true)
	if _, err := connection.UploadArtifact(context.Background(), server.URL, "01K00000000000000000000001", secret, []byte("Synthetic")); !errors.Is(err, ErrProtocol) {
		t.Fatal("oversized upload response accepted", err)
	}
}

func TestArtifactOriginAndGrantBounds(t *testing.T) {
	for _, origin := range []string{"https://user@example.test", "https://example.test/", "https://example.test/path", "https://example.test?", "https://example.test?q=x", "https://example.test#fragment", "http://example.test", "http://127.0.0.1:8080", "file:///tmp/artifact", "https://"} {
		if ValidArtifactOrigin(origin, "https://control.test") {
			t.Fatal("unsafe origin accepted", origin)
		}
	}
	if !ValidArtifactOrigin("https://artifacts.test:443", "https://control.test") || !ValidArtifactOrigin("http://127.0.0.1:8080", "http://localhost:8081") {
		t.Fatal("configured exact origins refused")
	}
	enrollment, credentials := testEnrollment(t)
	connection, err := NewConnection(enrollment, credentials, nil, func(context.Context, int64) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	for _, values := range [][3]string{{"https://artifact.test", "bad", strings.Repeat("A", 43)}, {"https://artifact.test", "01K00000000000000000000001", "bad"}, {"https://artifact.test/path", "01K00000000000000000000001", strings.Repeat("A", 43)}} {
		if _, err := connection.UploadArtifact(context.Background(), values[0], values[1], values[2], []byte("Synthetic")); !errors.Is(err, ErrProtocol) {
			t.Fatal("malformed grant input accepted", err)
		}
	}
}

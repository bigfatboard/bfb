// ABOUTME: Pins Go possession encoding to the committed C06 transcript and checks field-binding failures.
// ABOUTME: Rejects malformed credentials and ambiguous response JSON without relying on local wall-clock agreement.

package runner

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func TestC06TranscriptFixture(t *testing.T) {
	root, err := protocol.RepositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "protocol/fixtures/runner-possession.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Challenge  generated.RunnerChallenge `json:"challenge"`
		Transcript string                    `json:"transcript"`
		Digest     string                    `json:"transcript_sha256"`
	}
	if json.Unmarshal(data, &fixture) != nil {
		t.Fatal("fixture JSON")
	}
	transcript := challengeTranscript(fixture.Challenge)
	digest := sha256.Sum256(transcript)
	if string(transcript) != fixture.Transcript || hex.EncodeToString(digest[:]) != fixture.Digest {
		t.Fatal("Go differs from C06's committed transcript")
	}
}

func TestChallengeAndTokenBindings(t *testing.T) {
	enrollment, credentials := testEnrollment(t)
	_ = credentials
	now := time.Date(2026, 9, 12, 0, 0, 0, 0, time.UTC)
	challenge := testChallenge(enrollment, now, 4)
	enrollment.TokenEpoch = 4
	encoded, _ := json.Marshal(challenge)
	if _, err := validateChallenge(encoded, enrollment, nil, nil); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*generated.RunnerChallenge){
		"workspace":     func(c *generated.RunnerChallenge) { c.WorkspaceId = "01K00000000000000000000007" },
		"runner":        func(c *generated.RunnerChallenge) { c.RunnerId = "01K00000000000000000000008" },
		"audience":      func(c *generated.RunnerChallenge) { c.Audience = "bfb-human" },
		"origin":        func(c *generated.RunnerChallenge) { c.Origin = "https://other.synthetic.test" },
		"key":           func(c *generated.RunnerChallenge) { c.PublicKeyThumbprint = "sha256:" + strings.Repeat("a", 64) },
		"generation":    func(c *generated.RunnerChallenge) { c.TokenEpoch = 3 },
		"lifetime":      func(c *generated.RunnerChallenge) { c.ExpiresAt = now.Add(61 * time.Second).Format(time.RFC3339Nano) },
		"nonce padding": func(c *generated.RunnerChallenge) { c.ServerNonce += "=" },
		"purpose":       func(c *generated.RunnerChallenge) { c.Purpose = "request" },
	} {
		t.Run(name, func(t *testing.T) {
			altered := challenge
			change(&altered)
			data, _ := json.Marshal(altered)
			if _, err := validateChallenge(data, enrollment, nil, nil); err != ErrProtocol {
				t.Fatal("altered challenge accepted")
			}
		})
	}
	claims := testClaims(enrollment, challenge)
	encodeToken := func(c tokenClaims) string {
		body, _ := json.Marshal(c)
		return "bfb_runner_" + base64.RawURLEncoding.EncodeToString(body) + "." + base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	}
	expires := time.Unix(claims.Expires, 0).Format(time.RFC3339Nano)
	if _, err := validateToken(encodeToken(claims), expires, enrollment, challenge); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*tokenClaims){
		"workspace":    func(c *tokenClaims) { c.WorkspaceID = "01K00000000000000000000009" },
		"subject":      func(c *tokenClaims) { c.Subject = "01K00000000000000000000009" },
		"audience":     func(c *tokenClaims) { c.Audience = "bfb-human" },
		"issuer":       func(c *tokenClaims) { c.Issuer = "https://other.synthetic.test" },
		"key":          func(c *tokenClaims) { c.Confirmation.Thumbprint = "sha256:" + strings.Repeat("a", 64) },
		"runner epoch": func(c *tokenClaims) { c.AuthorizationEpoch++ },
		"owner epoch":  func(c *tokenClaims) { c.OwnerAuthorizationEpoch++ },
		"grant epoch":  func(c *tokenClaims) { c.GrantEpoch++ },
		"token epoch":  func(c *tokenClaims) { c.TokenEpoch-- },
		"expiry":       func(c *tokenClaims) { c.Expires++ },
		"issued":       func(c *tokenClaims) { c.Issued -= 61; c.Expires -= 61 },
	} {
		t.Run("token "+name, func(t *testing.T) {
			altered := claims
			change(&altered)
			if _, err := validateToken(encodeToken(altered), expires, enrollment, challenge); err != ErrProtocol {
				t.Fatal("altered token accepted")
			}
		})
	}
	request := binding("POST", enrollment.basePath()+"/inventory", []byte(`{"schema_version":1}`))
	challenge.Purpose = "request"
	challenge.TokenEpoch = claims.TokenEpoch
	challenge.TokenId = &claims.TokenID
	challenge.Request = map[string]any{"method": request.Method, "path": request.Path, "body_sha256": request.BodySHA256}
	encoded, _ = json.Marshal(challenge)
	if _, err := validateChallenge(encoded, enrollment, &request, &claims); err != nil {
		t.Fatal(err)
	}
	changed := request
	changed.BodySHA256 = strings.Repeat("0", 64)
	if _, err := validateChallenge(encoded, enrollment, &changed, &claims); err != ErrProtocol {
		t.Fatal("request body mismatch accepted")
	}
	changed = request
	changed.Method = "GET"
	if _, err := validateChallenge(encoded, enrollment, &changed, &claims); err != ErrProtocol {
		t.Fatal("request method mismatch accepted")
	}
	changed = request
	changed.Path += "/other"
	if _, err := validateChallenge(encoded, enrollment, &changed, &claims); err != ErrProtocol {
		t.Fatal("request path mismatch accepted")
	}
}

func TestStrictNativeJSONAndOrigins(t *testing.T) {
	for _, data := range []string{`{"token":"one","token":"two"}`, `{"token":"one","unexpected":true}`, `{"token":"one"} {}`, `{"token":"one"}\u0000`} {
		var target struct {
			Token string `json:"token"`
		}
		if strictJSON([]byte(data), &target) != ErrProtocol {
			t.Fatalf("ambiguous response accepted: %s", data)
		}
	}
	for _, origin := range []string{"http://localhost:8787", "https://user:password@bfb.test", "https://bfb.test/", "https://bfb.test?secret=x", "https://bfb.test#fragment", "https://BFB.test", "https://bfb.test/path"} {
		if _, err := canonicalOrigin(origin); err == nil {
			t.Fatalf("noncanonical origin accepted: %s", origin)
		}
	}
}

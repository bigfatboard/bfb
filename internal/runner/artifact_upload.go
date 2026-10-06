// ABOUTME: Sends bounded artifact snapshots to one authenticated deployment-issued upload grant.
// ABOUTME: Isolates cookie-less fixed PUT requests from runner credentials, redirects and arbitrary paths.

package runner

import (
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"time"
)

var artifactGrantID = regexp.MustCompile(`^[0-7][0-9A-HJKMNP-TV-Z]{25}$`)

// ArtifactUploadConnection is a fixed upload action, not a credential or URL
// proxy. Only an authenticated prepare response may supply its origin/grant.
type ArtifactUploadConnection interface {
	UploadArtifact(context.Context, string, string, string, []byte) ([]byte, error)
}

// ArtifactAuthority is an opaque local fence, not a credential. Token rotation
// with unchanged authorization does not change it; connection replacement does.
type ArtifactAuthority struct {
	connection              *Connection
	authorizationEpoch      int64
	ownerAuthorizationEpoch int64
	grantEpoch              int64
}

type ArtifactAuthorityConnection interface {
	ArtifactAuthority() (ArtifactAuthority, error)
}

// ArtifactAuthority rechecks daemon-known revocation and transport state after
// cloud work, before a private response is delivered to the local caller.
func (connection *Connection) ArtifactAuthority() (ArtifactAuthority, error) {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	if connection.enrollment.State == "revoked" {
		return ArtifactAuthority{}, ErrRevoked
	}
	if connection.closed || len(connection.token) == 0 || !time.Now().Before(connection.due) {
		return ArtifactAuthority{}, ErrOffline
	}
	return ArtifactAuthority{connection: connection, authorizationEpoch: connection.claims.AuthorizationEpoch, ownerAuthorizationEpoch: connection.claims.OwnerAuthorizationEpoch, grantEpoch: connection.claims.GrantEpoch}, nil
}

// UploadArtifact never uses possession headers or browser cookies. The single
// ephemeral grant is the only authorization sent to the separate upload origin.
func (connection *Connection) UploadArtifact(ctx context.Context, origin, grantID, secret string, content []byte) ([]byte, error) {
	if !ValidArtifactOrigin(origin, connection.enrollment.Origin) || !artifactGrantID.MatchString(grantID) || len(content) < 1 || len(content) > 5*1024*1024 {
		return nil, ErrProtocol
	}
	decoded, err := base64.RawURLEncoding.DecodeString(secret)
	if err != nil || len(decoded) != 32 || base64.RawURLEncoding.EncodeToString(decoded) != secret {
		clear(decoded)
		return nil, ErrProtocol
	}
	clear(decoded)
	connection.mu.Lock()
	closed, revoked := connection.closed, connection.enrollment.State == "revoked"
	connection.mu.Unlock()
	if closed {
		return nil, ErrOffline
	}
	if revoked {
		return nil, ErrRevoked
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, origin+"/upload/"+grantID, bytes.NewReader(content))
	if err != nil {
		return nil, ErrProtocol
	}
	request.Header.Set("Authorization", "Bearer "+secret)
	request.Header.Set("Content-Type", "application/octet-stream")
	request.Header.Set("Accept", "application/json")
	response, err := connection.client.Do(request)
	if err != nil {
		return nil, ErrOffline
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 4097))
	if err != nil {
		return nil, ErrOffline
	}
	if len(data) > 4096 {
		return nil, ErrProtocol
	}
	switch {
	case response.StatusCode == http.StatusOK:
		// Availability is never inferred from this acknowledgement. The Hub
		// independently verifies the canonical upload receipt at finalization.
		return data, nil
	case response.StatusCode == http.StatusForbidden || response.StatusCode == http.StatusUnauthorized:
		return data, ErrAuthorization
	case response.StatusCode >= 500:
		return nil, ErrOffline
	default:
		return nil, ErrProtocol
	}
}

// ValidArtifactOrigin accepts an exact HTTPS origin. Loopback HTTP is limited
// to an enrollment that itself explicitly uses the local HTTP test transport.
func ValidArtifactOrigin(origin, controlOrigin string) bool {
	u, err := url.Parse(origin)
	if err != nil || len(origin) > 512 || u.Host == "" || u.User != nil || u.Path != "" || u.RawPath != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawFragment != "" || u.Opaque != "" || u.String() != origin {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	control, err := url.Parse(controlOrigin)
	return err == nil && u.Scheme == "http" && control.Scheme == "http" && loopbackArtifactHost(u.Hostname()) && loopbackArtifactHost(control.Hostname())
}

func loopbackArtifactHost(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

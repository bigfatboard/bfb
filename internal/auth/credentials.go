// ABOUTME: Separates human, workspace-runner, and local-secret credential namespaces.
// ABOUTME: Defines the native credential boundary without providing a plaintext fallback.

package auth

import (
	"context"
	"errors"
	"regexp"
)

type CredentialKind string

const (
	HumanCredential CredentialKind = "human"
	RunnerKey       CredentialKind = "runner_key"
	RunnerToken     CredentialKind = "runner_token"
	LocalSecret     CredentialKind = "local_secret"
)

var ErrCredentialScope = errors.New("invalid credential namespace")
var identifier = regexp.MustCompile(`^[0-7][0-9A-HJKMNP-TV-Z]{25}$`)

type CredentialRef struct {
	Kind        CredentialKind
	WorkspaceID string
	ID          string
}

func (r CredentialRef) Account() (string, error) {
	if !identifier.MatchString(r.ID) {
		return "", ErrCredentialScope
	}
	switch r.Kind {
	case HumanCredential, RunnerKey, RunnerToken:
		if !identifier.MatchString(r.WorkspaceID) {
			return "", ErrCredentialScope
		}
	case LocalSecret:
		if r.WorkspaceID != "" {
			return "", ErrCredentialScope
		}
	default:
		return "", ErrCredentialScope
	}
	return "bfb/" + string(r.Kind) + "/" + r.WorkspaceID + "/" + r.ID, nil
}

// CredentialStore is implemented by signed native Keychain access in L08/L04.
// Callers must not persist a secret in SQLite when that implementation is unavailable.
type CredentialStore interface {
	Read(context.Context, CredentialRef) ([]byte, error)
	Write(context.Context, CredentialRef, []byte) error
	Delete(context.Context, CredentialRef) error
}

// RunnerSigner keeps signing-key bytes behind the native credential boundary.
type RunnerSigner interface {
	PublicKey(context.Context, CredentialRef) ([]byte, error)
	Sign(context.Context, CredentialRef, []byte) ([]byte, error)
}

// ABOUTME: Keeps per-workspace runner signing keys and tokens behind the native credential store.
// ABOUTME: Generates independent software P-256 keys and exposes only public JWKs and possession signatures.

package auth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
)

const KeychainService = "com.tenira.bfb.runner"
const DaemonSigningIdentifier = "com.tenira.bfb.daemon"
const maxCredentialBytes = 8192

var (
	ErrCredentialUnavailable = errors.New("native credential unavailable")
	ErrCredentialNotFound    = errors.New("native credential not found")
	ErrCredentialExists      = errors.New("native credential already exists")
)

// Keychain uses macOS access control; there is no file or environment fallback.
// Only a signed BFB daemon may construct it. The menu-bar app uses Local RPC.
type Keychain struct{}

func NewKeychain() (*Keychain, error) {
	if err := nativeCredentialIdentity(); err != nil {
		return nil, err
	}
	return &Keychain{}, nil
}

func runnerAccount(ref CredentialRef) (string, error) {
	if ref.Kind != RunnerKey && ref.Kind != RunnerToken {
		return "", ErrCredentialScope
	}
	return ref.Account()
}

func (store *Keychain) Read(ctx context.Context, ref CredentialRef) ([]byte, error) {
	account, err := runnerAccount(ref)
	if err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	return nativeCredentialRead(account)
}

// Write cannot replace a signing key. Enrollment identity changes require a new ID.
func (store *Keychain) Write(ctx context.Context, ref CredentialRef, value []byte) error {
	account, err := runnerAccount(ref)
	if err != nil {
		return err
	}
	if len(value) == 0 || len(value) > maxCredentialBytes {
		return ErrCredentialScope
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	return nativeCredentialWrite(account, value, ref.Kind == RunnerToken)
}

func (store *Keychain) Delete(ctx context.Context, ref CredentialRef) error {
	account, err := runnerAccount(ref)
	if err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	return nativeCredentialDelete(account)
}

func (store *Keychain) CreateKey(ctx context.Context, ref CredentialRef) ([]byte, error) {
	if ref.Kind != RunnerKey {
		return nil, ErrCredentialScope
	}
	if _, err := runnerAccount(ref); err != nil {
		return nil, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, ErrCredentialUnavailable
	}
	encoded, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, ErrCredentialUnavailable
	}
	defer clear(encoded)
	if err = store.Write(ctx, ref, encoded); err != nil {
		return nil, err
	}
	return publicJWK(&key.PublicKey)
}

func (store *Keychain) key(ctx context.Context, ref CredentialRef) (*ecdsa.PrivateKey, error) {
	if ref.Kind != RunnerKey {
		return nil, ErrCredentialScope
	}
	encoded, err := store.Read(ctx, ref)
	if err != nil {
		return nil, err
	}
	defer clear(encoded)
	parsed, err := x509.ParsePKCS8PrivateKey(encoded)
	key, ok := parsed.(*ecdsa.PrivateKey)
	if err != nil || !ok || key.Curve != elliptic.P256() {
		return nil, ErrCredentialUnavailable
	}
	return key, nil
}

func (store *Keychain) PublicKey(ctx context.Context, ref CredentialRef) ([]byte, error) {
	key, err := store.key(ctx, ref)
	if err != nil {
		return nil, err
	}
	return publicJWK(&key.PublicKey)
}

func publicJWK(key *ecdsa.PublicKey) ([]byte, error) {
	return json.Marshal(struct {
		Curve string `json:"crv"`
		Kind  string `json:"kty"`
		X     string `json:"x"`
		Y     string `json:"y"`
	}{"P-256", "EC", base64.RawURLEncoding.EncodeToString(key.X.FillBytes(make([]byte, 32))), base64.RawURLEncoding.EncodeToString(key.Y.FillBytes(make([]byte, 32)))})
}

func (store *Keychain) Sign(ctx context.Context, ref CredentialRef, transcript []byte) ([]byte, error) {
	if len(transcript) == 0 || len(transcript) > maxCredentialBytes {
		return nil, ErrCredentialScope
	}
	key, err := store.key(ctx, ref)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(transcript)
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		return nil, ErrCredentialUnavailable
	}
	result := make([]byte, 64)
	r.FillBytes(result[:32])
	s.FillBytes(result[32:])
	return result, nil
}

// ABOUTME: Exercises native runner credentials in separately signed synthetic test processes.
// ABOUTME: Emits only public keys and boolean assertions and deletes only its exact generated records.

package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"os"

	"github.com/qdis/bfb/internal/auth"
)

const syntheticToken = "BFB_SYNTHETIC_RUNNER_TOKEN_CANNOT_AUTHENTICATE"

func main() {
	if len(os.Args) != 4 {
		os.Exit(2)
	}
	ctx := context.Background()
	store, err := auth.NewKeychain()
	if err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]bool{"identity_denied": true})
		os.Exit(3)
	}
	key := auth.CredentialRef{Kind: auth.RunnerKey, WorkspaceID: os.Args[2], ID: os.Args[3]}
	token := auth.CredentialRef{Kind: auth.RunnerToken, WorkspaceID: key.WorkspaceID, ID: key.ID}
	var result any
	switch os.Args[1] {
	case "create":
		var public []byte
		public, err = store.CreateKey(ctx, key)
		if err == nil {
			err = store.Write(ctx, token, []byte(syntheticToken))
		}
		result = map[string]any{"public_key": json.RawMessage(public)}
	case "check":
		var public, signature, secret []byte
		public, err = store.PublicKey(ctx, key)
		if err == nil {
			signature, err = store.Sign(ctx, key, []byte("BFB synthetic possession test"))
		}
		if err == nil {
			secret, err = store.Read(ctx, token)
		}
		var jwk struct{ X, Y string }
		if err == nil {
			err = json.Unmarshal(public, &jwk)
		}
		x, _ := base64.RawURLEncoding.DecodeString(jwk.X)
		y, _ := base64.RawURLEncoding.DecodeString(jwk.Y)
		digest := sha256.Sum256([]byte("BFB synthetic possession test"))
		verified := false
		if err == nil && len(signature) == 64 {
			verified = ecdsa.Verify(&ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}, digest[:], new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:]))
		}
		result = map[string]bool{"signature_valid": verified, "token_matches": string(secret) == syntheticToken}
		clear(secret)
	case "replace":
		err = store.Write(ctx, token, []byte("BFB_SYNTHETIC_REPLACEMENT"))
		if err == nil {
			err = store.Write(ctx, token, []byte(syntheticToken))
		}
		_, duplicate := store.CreateKey(ctx, key)
		result = map[string]bool{"key_immutable": duplicate == auth.ErrCredentialExists, "token_replaced": err == nil}
	case "delete":
		err = store.Delete(ctx, token)
		if err == nil {
			err = store.Delete(ctx, key)
		}
		result = map[string]bool{"deleted": err == nil}
	default:
		os.Exit(2)
	}
	if err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]bool{"credential_failed": true})
		os.Exit(4)
	}
	_ = json.NewEncoder(os.Stdout).Encode(result)
}

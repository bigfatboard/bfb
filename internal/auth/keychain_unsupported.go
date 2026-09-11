// ABOUTME: Fails runner credential operations on builds without native macOS Keychain access.
// ABOUTME: Preserves portable tooling without allowing unprotected credentials or dummy enrollment.

//go:build !darwin || !cgo

package auth

func nativeCredentialIdentity() error                  { return ErrCredentialUnavailable }
func nativeCredentialRead(string) ([]byte, error)      { return nil, ErrCredentialUnavailable }
func nativeCredentialWrite(string, []byte, bool) error { return ErrCredentialUnavailable }
func nativeCredentialDelete(string) error              { return ErrCredentialUnavailable }

// ABOUTME: Stores the human device credential in one mode-0600 file per state dir.
// ABOUTME: Credentials travel via files or environment only, never process arguments.

package humancli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Credential is the locally cached device credential plus its public envelope.
type Credential struct {
	WorkspaceID string `json:"workspace_id"`
	Credential  string `json:"credential"`
	KeyPrefix   string `json:"key_prefix"`
	ExpiresAt   string `json:"expires_at"`
}

// credentialPattern matches values that must never appear in argv, output, or logs.
var credentialPattern = regexp.MustCompile(`bfb_cli_[A-Za-z0-9_-]{10,}`)

// ForbiddenFlags are refused anywhere in argv so secrets cannot enter process lists.
var ForbiddenFlags = []string{
	"--credential", "--token", "--secret", "--password", "--cookie", "--authorization",
}

// CheckArgv rejects secret-bearing flags before any command runs.
func CheckArgv(args []string) *Failure {
	for _, arg := range args {
		name := arg
		if cut, _, ok := strings.Cut(arg, "="); ok {
			name = cut
		}
		for _, forbidden := range ForbiddenFlags {
			if name == forbidden {
				return fail("invalid_request", "secrets travel in files, never in process arguments")
			}
		}
	}
	return nil
}

// Redact replaces credential-shaped values with a fixed placeholder.
func Redact(text string) string { return credentialPattern.ReplaceAllString(text, "[redacted-credential]") }

// ContainsCredential reports whether text carries a credential-shaped value.
func ContainsCredential(text string) bool { return credentialPattern.MatchString(text) }

// Store persists one active credential per state directory.
type Store struct{ Dir string }

func (s Store) path() string { return filepath.Join(s.Dir, "cli-credential.json") }

// Write stores the credential with owner-only permissions and no extra copies.
func (s Store) Write(credential Credential) *Failure {
	if credential.Credential == "" || ContainsCredential(credential.WorkspaceID) {
		return fail("invalid_request", "the credential record is invalid")
	}
	data, err := json.Marshal(credential)
	if err != nil {
		return fail("internal_error", "the local operation failed")
	}
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return fail("storage_failed", "local storage could not be opened or verified")
	}
	file, err := os.OpenFile(s.path(), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return fail("storage_failed", "local storage could not be opened or verified")
	}
	defer file.Close()
	if _, err := file.Write(append(data, '\n')); err != nil {
		return fail("storage_failed", "local storage could not be opened or verified")
	}
	if err := file.Chmod(0o600); err != nil {
		return fail("storage_failed", "local storage could not be opened or verified")
	}
	return nil
}

// Read loads the credential, preferring the test-only environment override.
// The override accepts any non-empty value so substitution tests can present
// foreign credentials; the server remains the authority that rejects them.
func (s Store) Read() (Credential, *Failure) {
	if override := os.Getenv("BFB_CLI_CREDENTIAL"); override != "" {
		fields := strings.SplitN(strings.TrimSpace(override), ":", 2)
		if len(fields) != 2 || fields[0] == "" || fields[1] == "" {
			return Credential{}, fail("invalid_request", "the test credential override is invalid")
		}
		return Credential{WorkspaceID: fields[0], Credential: fields[1]}, nil
	}
	data, err := os.ReadFile(s.path())
	if err != nil {
		return Credential{}, fail("credential_missing", "no CLI credential is stored; run bfb login")
	}
	var credential Credential
	if err := json.Unmarshal(data, &credential); err != nil || credential.Credential == "" {
		return Credential{}, fail("credential_missing", "no CLI credential is stored; run bfb login")
	}
	return credential, nil
}

// Delete forgets the credential; logout and revocation sync call this.
func (s Store) Delete() *Failure {
	if err := os.Remove(s.path()); err != nil && !os.IsNotExist(err) {
		return fail("storage_failed", "local storage could not be opened or verified")
	}
	return nil
}

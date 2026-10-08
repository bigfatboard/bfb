// ABOUTME: Verifies human, workspace runner and local credential namespace separation.
// ABOUTME: Rejects ambiguous identifiers without creating or reading any real credential.

package auth

import "testing"

func TestCredentialNamespacesAreDisjoint(t *testing.T) {
	const first = "01J00000000000000000000001"
	const second = "01J00000000000000000000002"
	seen := map[string]bool{}
	for _, kind := range []CredentialKind{HumanCredential, RunnerKey, RunnerToken} {
		for _, workspace := range []string{first, second} {
			account, err := (CredentialRef{Kind: kind, WorkspaceID: workspace, ID: first}).Account()
			if err != nil || seen[account] {
				t.Fatalf("namespace collision: %v", err)
			}
			seen[account] = true
		}
	}
	account, err := (CredentialRef{Kind: LocalSecret, ID: first}).Account()
	if err != nil || seen[account] {
		t.Fatal("local namespace collision")
	}
	for _, ref := range []CredentialRef{{Kind: RunnerKey, ID: first}, {Kind: LocalSecret, ID: first, WorkspaceID: first}, {Kind: "unknown", ID: first}, {Kind: RunnerToken, ID: "../secret", WorkspaceID: first}} {
		if _, err := ref.Account(); err == nil {
			t.Fatal("accepted invalid credential reference")
		}
	}
}

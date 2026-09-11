// ABOUTME: Verifies actual APFS canonical case spelling and alias-independent worktree identity.
// ABOUTME: Fails the macOS acceptance lane if its fixtures are not backed by APFS.

package checkout

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func TestAPFSCaseAndPhysicalIdentity(t *testing.T) {
	root := fixtureRepository(t, true)
	var stat unix.Statfs_t
	must(t, unix.Statfs(root, &stat))
	if unix.ByteSliceToString(stat.Fstypename[:]) != "apfs" {
		t.Fatal("macOS checkout acceptance requires real APFS fixtures")
	}
	canonical, identity, err := canonicalDirectory(root)
	must(t, err)
	if filepath.Base(canonical) != "ExactCheckout" {
		t.Fatal("canonical spelling was not preserved")
	}
	variation := filepath.Join(filepath.Dir(root), strings.ToLower(filepath.Base(root)))
	_, statErr := os.Stat(variation)
	if os.IsNotExist(statErr) {
		_, _, err = canonicalDirectory(variation)
		requireFailure(t, err, "checkout_path_missing")
		t.Log("case-sensitive APFS rejects the absent variation")
		return
	}
	must(t, statErr)
	aliased, aliasIdentity, err := canonicalDirectory(variation)
	must(t, err)
	if aliased != canonical || aliasIdentity != identity {
		t.Fatal("case variant bypassed canonical filesystem identity")
	}
	registry, _, _ := fixtureRegistry(t)
	_, err = registry.Link(context.Background(), linkInput(root))
	must(t, err)
	_, err = registry.Link(context.Background(), linkInput(variation))
	requireFailure(t, err, "checkout_already_linked")
	t.Log("case-insensitive APFS aliases share one canonical identity")
}

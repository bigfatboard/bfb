// ABOUTME: Exercises real pinned-directory artifact reads against aliases and unsafe local files.
// ABOUTME: Proves immutable bounded copies without creating or repairing missing preparation.

package supervisor

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qdis/bfb/internal/provider"
	"golang.org/x/sys/unix"
)

func TestPreparedArtifactCopiesOneBoundedSnapshot(t *testing.T) {
	files, draft, assignment, installation, checkout := fixturePreparation(t)
	preparation, err := files.prepare(draft, installation, provider.Hash(nil), checkout)
	if err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(preparation.Artifacts.Path, "nested")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "review.md")
	if err := os.WriteFile(path, []byte("Original review\n"), 0600); err != nil {
		t.Fatal(err)
	}
	content, err := files.ReadArtifactSnapshot(context.Background(), assignment, checkout, "nested/review.md", 16)
	if err != nil || string(content) != "Original review\n" {
		t.Fatal("pinned snapshot read failed", err)
	}
	if err := os.WriteFile(path, []byte("Changed review\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if string(content) != "Original review\n" {
		t.Fatal("later file change altered the in-memory snapshot")
	}
	if _, err := files.ReadArtifactSnapshot(context.Background(), assignment, checkout, "nested/review.md", 3); err == nil {
		t.Fatal("oversized artifact accepted")
	}
}

func TestPreparedArtifactRejectsUnsafeSelectorsAndFiles(t *testing.T) {
	for _, fault := range []string{"absolute", "traversal", "cleaned", "control", "invalid_utf8", "missing", "empty", "directory", "fifo", "symlink_leaf", "symlink_parent", "hardlink", "public_leaf", "public_parent", "replaced_root", "missing_preparation", "changed_assignment"} {
		t.Run(fault, func(t *testing.T) {
			files, draft, assignment, installation, checkout := fixturePreparation(t)
			preparation, err := files.prepare(draft, installation, provider.Hash(nil), checkout)
			if err != nil {
				t.Fatal(err)
			}
			directory := filepath.Join(preparation.Artifacts.Path, "nested")
			if err := os.Mkdir(directory, 0700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(directory, "review.md")
			if err := os.WriteFile(path, []byte("Synthetic private artifact"), 0600); err != nil {
				t.Fatal(err)
			}
			relative := "nested/review.md"
			switch fault {
			case "absolute":
				relative = path
			case "traversal":
				relative = "../review.md"
			case "cleaned":
				relative = "nested/../nested/review.md"
			case "control":
				relative += "\n"
			case "invalid_utf8":
				relative += "\xff"
			case "missing":
				err = os.Remove(path)
			case "empty":
				err = os.Truncate(path, 0)
			case "directory":
				relative = "nested"
			case "fifo":
				relative = "pipe"
				err = unix.Mkfifo(filepath.Join(preparation.Artifacts.Path, relative), 0600)
			case "symlink_leaf":
				if err = os.Rename(path, path+"-original"); err == nil {
					err = os.Symlink(path+"-original", path)
				}
			case "symlink_parent":
				if err = os.Rename(directory, directory+"-original"); err == nil {
					err = os.Symlink(directory+"-original", directory)
				}
			case "hardlink":
				err = os.Link(path, filepath.Join(t.TempDir(), "outside-alias"))
			case "public_leaf":
				err = os.Chmod(path, 0644)
			case "public_parent":
				err = os.Chmod(directory, 0755)
			case "replaced_root":
				if err = os.Rename(preparation.Artifacts.Path, preparation.Artifacts.Path+"-original"); err == nil {
					err = os.Mkdir(preparation.Artifacts.Path, 0700)
				}
			case "missing_preparation":
				err = os.Remove(filepath.Join(files.directory.file.Name(), draft.IntentID+".preparation.json"))
			case "changed_assignment":
				assignment.Claim.FencingGeneration++
			}
			if err != nil {
				t.Fatal(err)
			}
			if bytes, err := files.ReadArtifactSnapshot(context.Background(), assignment, checkout, relative, 1024); err == nil || bytes != nil {
				t.Fatal("unsafe artifact produced bytes", fault)
			}
		})
	}
	for _, path := range []string{"", ".", "nested//file", strings.Repeat("x", 4097)} {
		if artifactRelativePath(path) {
			t.Fatal("invalid selector accepted")
		}
	}
}

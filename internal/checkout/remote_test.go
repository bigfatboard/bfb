// ABOUTME: Covers hosted Git remote equivalence and rejects local or ambiguous repository identities.
// ABOUTME: Ensures credentials and unsafe project path syntax never enter sanitized summaries.

package checkout

import "testing"

func TestRemoteNormalization(t *testing.T) {
	for _, remote := range []string{
		"git@GitHub.com:QDIS/BFB.git", "ssh://git@github.com/Qdis/Bfb.git",
		"ssh://git@github.com:22/QDIS/BFB", "https://github.com/Qdis/BFB/",
		"https://synthetic-user:synthetic-secret@GITHUB.com:443/QDIS/BFB.git",
	} {
		got, err := NormalizeRemote(remote)
		if err != nil || got != "github.com/qdis/bfb" {
			t.Fatalf("normalization: %q %v", got, err)
		}
	}
	got, err := NormalizeRemote("git@gitlab.example.test:Group/SubGroup/Repo.git")
	if err != nil || got != "gitlab.example.test/Group/SubGroup/Repo" {
		t.Fatalf("case-sensitive host: %s %v", got, err)
	}
	for _, remote := range []string{
		"/synthetic/repo", "../repo", "file:///synthetic/repo", "ext::touch canary",
		"http://github.com/qdis/bfb", "git://github.com/qdis/bfb", "https://github.com:444/qdis/bfb",
		"ssh://github.com:2222/qdis/bfb", "https://github.com/qdis/bfb?secret=x",
		"https://github.com/qdis/bfb#secret", "https://github.com/qdis/%62fb",
		"git@github.com:/qdis/bfb", "https://github.com/qdis/../bfb",
		"git@github.com:qdis/bfb.git\n", "github.com/qdis/bfb",
	} {
		_, err := NormalizeRemote(remote)
		requireFailure(t, err, "checkout_repository_mismatch")
	}
	for _, subpath := range []string{"/private", "../repo", "a/../b", "a//b", "./a", "a/", "a\\b", "~timo", "a\nb"} {
		_, err := normalizeSubpath(subpath)
		requireFailure(t, err, "checkout_subpath_mismatch")
	}
}

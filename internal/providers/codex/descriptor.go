// ABOUTME: Owns Codex registration and version discovery independently of other provider packages.
// ABOUTME: Withholds tracked capabilities until the Codex adapter and integration are certified.

package codex

import "github.com/qdis/bfb/internal/provider"

func Descriptor() provider.Descriptor {
	return provider.Descriptor{Name: "codex", VersionArguments: []string{"--version"}, ParseVersion: provider.ParseVersion("codex-cli ", ""), Manifest: provider.Manifest{Provider: "codex", Version: "1.0.0", TestedVersions: []string{}, Capabilities: []string{}, Models: []string{}}}
}

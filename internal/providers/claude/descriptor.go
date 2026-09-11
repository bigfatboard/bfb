// ABOUTME: Owns Claude registration and version discovery independently of other provider packages.
// ABOUTME: Withholds tracked capabilities until the Claude adapter and integration are certified.

package claude

import "github.com/qdis/bfb/internal/provider"

func Descriptor() provider.Descriptor {
	return provider.Descriptor{Name: "claude", VersionArguments: []string{"--version"}, ParseVersion: provider.ParseVersion("", " (Claude Code)"), Manifest: provider.Manifest{Provider: "claude", Version: "1.0.0", TestedVersions: []string{}, Capabilities: []string{}, Models: []string{}}}
}

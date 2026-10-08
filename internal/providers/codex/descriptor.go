// ABOUTME: Owns Codex registration and version discovery independently of other provider packages.
// ABOUTME: Grants only tested 0.153.4 capabilities; unknown versions fail closed with no inheritance.

package codex

import "github.com/qdis/bfb/internal/provider"

// Descriptor returns the provider-local Codex descriptor. Registration stays
// provider-local so parallel provider packages never edit a shared registry.
func Descriptor() provider.Descriptor {
	return provider.Descriptor{
		Name:             "codex",
		VersionArguments: []string{"--version"},
		ParseVersion:     provider.ParseVersion("codex-cli ", ""),
		Manifest: provider.Manifest{
			Provider:       "codex",
			Version:        ManifestVersion,
			TestedVersions: append([]string{}, TestedVersions...),
			Capabilities:   Capabilities(),
			Models:         append([]string{}, TestedModels...),
		},
		Adapter: Adapter{},
	}
}

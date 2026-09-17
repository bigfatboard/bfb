// ABOUTME: Owns Grok registration and version discovery independently of other provider packages.
// ABOUTME: Grants only tested 1.0.34 capabilities; unknown versions fail closed with no inheritance.

package grok

import (
	"regexp"
	"strings"

	"github.com/qdis/bfb/internal/provider"
)

// versionOutput matches the installed 1.0.34 banner with and without the
// release-channel suffix. A bare temporary home prints no channel while the
// standard install prints [stable]; both describe the same tested binary.
var versionOutput = regexp.MustCompile(`^grok ([0-9]+\.[0-9]+\.[0-9]+) \([a-f0-9]{12}\)( \[[A-Za-z][A-Za-z0-9_-]*\])?$`)

func parseVersion(raw []byte) (string, error) {
	if len(raw) > 256 {
		return "", provider.Failure("provider_probe_failed")
	}
	match := versionOutput.FindStringSubmatch(strings.TrimSpace(string(raw)))
	if len(match) != 3 {
		return "", provider.Failure("provider_probe_failed")
	}
	return match[1], nil
}

// Descriptor returns the provider-local Grok descriptor. Registration stays
// provider-local so parallel provider packages never edit a shared registry.
func Descriptor() provider.Descriptor {
	return provider.Descriptor{
		Name:             "grok",
		VersionArguments: []string{"--version"},
		ParseVersion:     parseVersion,
		Manifest: provider.Manifest{
			Provider:       "grok",
			Version:        ManifestVersion,
			TestedVersions: append([]string{}, TestedVersions...),
			Capabilities:   Capabilities(),
			Models:         append([]string{}, TestedModels...),
		},
		Adapter: Adapter{},
	}
}

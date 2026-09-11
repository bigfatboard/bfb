// ABOUTME: Owns Grok registration and version discovery independently of other provider packages.
// ABOUTME: Withholds tracked capabilities until the Grok adapter and integration are certified.

package grok

import (
	"regexp"
	"strings"

	"github.com/qdis/bfb/internal/provider"
)

var versionOutput = regexp.MustCompile(`^grok ([0-9]+\.[0-9]+\.[0-9]+) \([a-f0-9]{12}\) \[stable\]$`)

func parseVersion(raw []byte) (string, error) {
	if len(raw) > 256 {
		return "", provider.Failure("provider_probe_failed")
	}
	match := versionOutput.FindStringSubmatch(strings.TrimSpace(string(raw)))
	if len(match) != 2 {
		return "", provider.Failure("provider_probe_failed")
	}
	return match[1], nil
}

func Descriptor() provider.Descriptor {
	return provider.Descriptor{Name: "grok", VersionArguments: []string{"--version"}, ParseVersion: parseVersion, Manifest: provider.Manifest{Provider: "grok", Version: "1.0.0", TestedVersions: []string{}, Capabilities: []string{}, Models: []string{}}}
}

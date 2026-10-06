// ABOUTME: Defines an exact-version experimental Claude registry for an isolated certification bundle.
// ABOUTME: Reuses real adapter inspection and pins the binary without changing production capability ceilings.

package main

import (
	"context"
	"slices"
	"strings"

	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers"
	"github.com/qdis/bfb/internal/providers/claude"
)

const candidateVersion = "2.1.291"
const candidateManifestVersion = "0.0.1"

func candidateInstallation(binding candidateBinding) func(context.Context, string) (provider.Installation, error) {
	return func(ctx context.Context, name string) (provider.Installation, error) {
		if name != "claude" {
			return provider.Installation{}, provider.Failure("provider_unsupported")
		}
		installation, err := providers.LocalInstallation(ctx, name)
		if err != nil {
			return provider.Installation{}, err
		}
		stamp, err := provider.FingerprintExecutable(installation.Executable)
		if err != nil || stamp.CanonicalPath != binding.BinaryPath || stamp.Hash != binding.BinaryHash {
			return provider.Installation{}, provider.Failure("provider_changed")
		}
		// The resolved alias is no longer a later PATH selection. The normal kit
		// still fingerprints/revalidates this exact source before actual execution.
		installation.Executable = binding.BinaryPath
		return installation, nil
	}
}

func guardCandidateDoctor(ctx context.Context, arguments []string, installation func(context.Context, string) (provider.Installation, error)) error {
	// fixedArguments has already pinned/remapped the sole global data directory
	// and rejected argument delimiters. Only doctor performs an independent CLI
	// version observation; hooks/MCP/lifecycle must not depend on a GUI PATH.
	words := []string{}
	for _, word := range arguments[2:] {
		if word != "--json" {
			words = append(words, word)
		}
	}
	command := strings.Join(words, " ")
	if command == "provider doctor claude" || strings.HasPrefix(command, "provider doctor claude ") {
		_, err := installation(ctx, "claude")
		return err
	}
	return nil
}

type candidateAdapter struct {
	claude.Adapter
	binding candidateBinding
}

func (adapter candidateAdapter) Inspect(ctx context.Context, installation provider.Installation) (provider.RuntimeHealth, error) {
	stamp, err := provider.FingerprintExecutable(installation.Executable)
	if err != nil || stamp.CanonicalPath != adapter.binding.BinaryPath || stamp.Hash != adapter.binding.BinaryHash {
		return provider.RuntimeHealth{}, provider.Failure("provider_changed")
	}
	health, err := adapter.Adapter.Inspect(ctx, installation)
	if err != nil {
		return provider.RuntimeHealth{}, err
	}
	// This explicit experiment is not a certified capability. Its only extra
	// surface is the measured MCP protocol; real owned integration still gates it.
	if health.Healthy && slices.Contains(health.Capabilities, "hooks.session_start") && slices.Contains(health.Capabilities, "context.session_start") {
		health.Capabilities = append(health.Capabilities, "mcp.stdio")
	}
	return health, nil
}

func candidateRegistry(binding candidateBinding) (*provider.Registry, error) {
	descriptor := claude.Descriptor()
	descriptor.Manifest.Version = candidateManifestVersion
	descriptor.Manifest.TestedVersions = []string{candidateVersion}
	descriptor.Manifest.Capabilities = append(descriptor.Manifest.Capabilities, "mcp.stdio")
	descriptor.Adapter = candidateAdapter{binding: binding}
	return provider.NewRegistry([]provider.Descriptor{descriptor})
}

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
const candidateManifestVersion = "0.0.2"

var autonomousCapabilities = []string{"approval.never", "filesystem.full_access"}

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

func (adapter candidateAdapter) Launch(input provider.LaunchInput) (provider.Invocation, error) {
	invocation, err := adapter.Adapter.Launch(input)
	if err != nil {
		return provider.Invocation{}, err
	}
	invocation.SupervisionMode = provider.RootSupervision
	return invocation, nil
}

func (adapter candidateAdapter) Resume(input provider.ResumeInput) (provider.Invocation, error) {
	invocation, err := adapter.Adapter.Resume(input)
	if err != nil {
		return provider.Invocation{}, err
	}
	invocation.SupervisionMode = provider.RootSupervision
	return invocation, nil
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
	// These explicit experiments are not production-certified capabilities.
	// The exact pinned candidate and current owned integration gate them.
	if health.Healthy && slices.Contains(health.Capabilities, "hooks.session_start") && slices.Contains(health.Capabilities, "context.session_start") {
		health.Capabilities = append(health.Capabilities, "mcp.stdio")
		health.Capabilities = append(health.Capabilities, autonomousCapabilities...)
	}
	return health, nil
}

func candidateRegistry(binding candidateBinding) (*provider.Registry, error) {
	descriptor := claude.Descriptor()
	descriptor.Manifest.Version = candidateManifestVersion
	descriptor.Manifest.TestedVersions = []string{candidateVersion}
	descriptor.Manifest.Capabilities = append(descriptor.Manifest.Capabilities, "mcp.stdio")
	descriptor.Manifest.Capabilities = append(descriptor.Manifest.Capabilities, autonomousCapabilities...)
	descriptor.Adapter = candidateAdapter{Adapter: claude.Adapter{AllowAutonomousPermissions: true}, binding: binding}
	return provider.NewRegistry([]provider.Descriptor{descriptor})
}

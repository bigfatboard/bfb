// ABOUTME: Parses bounded repository YAML into the cloud-compatible canonical restriction document.
// ABOUTME: Rejects unsafe files, ambiguous YAML, unknown fields and policy widening without exposing content.

package checkout

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"

	"go.yaml.in/yaml/v3"
	"golang.org/x/sys/unix"
)

const MaxConfigBytes = 8192

type RepositoryConfig struct {
	Canonical string
	Hash      string
	document  map[string]any
}

type Policy struct {
	AllowedProviders      []string `json:"allowed_providers"`
	AllowAgentRootPropose bool     `json:"allow_agent_root_propose"`
	AllowPassToAgent      bool     `json:"allow_pass_to_agent"`
	AllowRunOverrides     bool     `json:"allow_run_overrides"`
}

func digest(value string) string {
	return fmt.Sprintf("sha256:%x", sha256.Sum256([]byte(value)))
}

func ParseRepositoryConfig(data []byte) (RepositoryConfig, error) {
	if len(data) > MaxConfigBytes {
		return RepositoryConfig{}, failure("checkout_config_invalid")
	}
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	var document yaml.Node
	err := decoder.Decode(&document)
	if err != nil && err != io.EOF {
		return RepositoryConfig{}, failure("checkout_config_invalid")
	}
	values := map[string]any{}
	if err != io.EOF {
		if document.Kind != yaml.DocumentNode || len(document.Content) != 1 {
			return RepositoryConfig{}, failure("checkout_config_invalid")
		}
		root := document.Content[0]
		if root.Kind != yaml.MappingNode || root.Tag != "!!map" || len(root.Content) > 8 {
			return RepositoryConfig{}, failure("checkout_config_invalid")
		}
		nodes := 0
		if !safeConfigNode(&document, 0, &nodes) {
			return RepositoryConfig{}, failure("checkout_config_invalid")
		}
		for index := 0; index < len(root.Content); index += 2 {
			key, value := root.Content[index], root.Content[index+1]
			if key.Kind != yaml.ScalarNode || key.Tag != "!!str" {
				return RepositoryConfig{}, failure("checkout_config_invalid")
			}
			if _, exists := values[key.Value]; exists {
				return RepositoryConfig{}, failure("checkout_config_invalid")
			}
			switch key.Value {
			case "allowed_providers":
				if value.Kind != yaml.SequenceNode || value.Tag != "!!seq" || len(value.Content) > 16 {
					return RepositoryConfig{}, failure("checkout_config_invalid")
				}
				providers := []string{}
				for _, provider := range value.Content {
					if provider.Kind != yaml.ScalarNode || provider.Tag != "!!str" || !knownProvider(provider.Value) {
						return RepositoryConfig{}, failure("checkout_config_invalid")
					}
					providers = append(providers, provider.Value)
				}
				slices.Sort(providers)
				values[key.Value] = slices.Compact(providers)
			case "allow_agent_root_propose", "allow_pass_to_agent", "allow_run_overrides":
				if value.Kind != yaml.ScalarNode || value.Tag != "!!bool" || (value.Value != "true" && value.Value != "false") {
					return RepositoryConfig{}, failure("checkout_config_invalid")
				}
				values[key.Value] = value.Value == "true"
			default:
				return RepositoryConfig{}, failure("checkout_config_invalid")
			}
		}
		var extra yaml.Node
		if decoder.Decode(&extra) != io.EOF {
			return RepositoryConfig{}, failure("checkout_config_invalid")
		}
	}
	canonical, err := json.Marshal(values)
	if err != nil {
		return RepositoryConfig{}, failure("checkout_config_invalid")
	}
	return RepositoryConfig{Canonical: string(canonical), Hash: digest(string(canonical)), document: values}, nil
}

func safeConfigNode(node *yaml.Node, depth int, count *int) bool {
	*count += 1
	if depth > 8 || *count > 64 || node.Kind == yaml.AliasNode || node.Anchor != "" {
		return false
	}
	for _, child := range node.Content {
		if !safeConfigNode(child, depth+1, count) {
			return false
		}
	}
	return true
}

func knownProvider(provider string) bool {
	return provider == "claude" || provider == "codex" || provider == "grok"
}

// Tighten requires the authoritative parent policy; a config document alone grants nothing.
func (config RepositoryConfig) Tighten(parent Policy) (Policy, error) {
	canonical, err := json.Marshal(config.document)
	if err != nil || config.document == nil || string(canonical) != config.Canonical || config.Hash != digest(config.Canonical) {
		return Policy{}, failure("checkout_config_invalid")
	}
	for _, provider := range parent.AllowedProviders {
		if !knownProvider(provider) {
			return Policy{}, failure("checkout_config_invalid")
		}
	}
	effective := parent
	effective.AllowedProviders = slices.Clone(parent.AllowedProviders)
	if values, exists := config.document["allowed_providers"]; exists {
		effective.AllowedProviders = slices.Clone(values.([]string))
		for _, provider := range effective.AllowedProviders {
			if !slices.Contains(parent.AllowedProviders, provider) {
				return Policy{}, failure("checkout_policy_widening")
			}
		}
	}
	for key, pair := range map[string]struct {
		parent bool
		child  *bool
	}{
		"allow_agent_root_propose": {parent.AllowAgentRootPropose, &effective.AllowAgentRootPropose},
		"allow_pass_to_agent":      {parent.AllowPassToAgent, &effective.AllowPassToAgent},
		"allow_run_overrides":      {parent.AllowRunOverrides, &effective.AllowRunOverrides},
	} {
		if value, exists := config.document[key]; exists {
			if value.(bool) && !pair.parent {
				return Policy{}, failure("checkout_policy_widening")
			}
			*pair.child = value.(bool)
		}
	}
	slices.Sort(effective.AllowedProviders)
	effective.AllowedProviders = slices.Compact(effective.AllowedProviders)
	return effective, nil
}

// CheckExecution binds a fresh observation to an immutable launch specification and parent ceiling.
func (config RepositoryConfig) CheckExecution(expectedHash string, parent Policy) (Policy, error) {
	if config.Hash != expectedHash || !strings.HasPrefix(expectedHash, "sha256:") {
		return Policy{}, failure("checkout_config_changed")
	}
	return config.Tighten(parent)
}

func readRepositoryConfig(root string) (RepositoryConfig, error) {
	rootFD, err := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return RepositoryConfig{}, failure("checkout_path_unsafe")
	}
	defer func() { _ = unix.Close(rootFD) }()
	directory, err := unix.Openat(rootFD, ".bfb", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err == unix.ENOENT {
		return ParseRepositoryConfig(nil)
	}
	if err != nil {
		return RepositoryConfig{}, failure("checkout_path_unsafe")
	}
	defer func() { _ = unix.Close(directory) }()
	fd, err := unix.Openat(directory, "config.yaml", unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err == unix.ENOENT {
		return ParseRepositoryConfig(nil)
	}
	if err != nil {
		return RepositoryConfig{}, failure("checkout_path_unsafe")
	}
	file := os.NewFile(uintptr(fd), "repository-config")
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return RepositoryConfig{}, failure("checkout_path_unsafe")
	}
	if info.Size() > MaxConfigBytes {
		return RepositoryConfig{}, failure("checkout_config_invalid")
	}
	data, err := io.ReadAll(io.LimitReader(file, MaxConfigBytes+1))
	if err != nil {
		return RepositoryConfig{}, failure("checkout_config_invalid")
	}
	return ParseRepositoryConfig(data)
}

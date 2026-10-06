// ABOUTME: Reads the isolated pilot's signed resource binding and fixes every helper entry point to one state.
// ABOUTME: Rejects alternate state, home, binary and service-install inputs before normal command dispatch.

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/qdis/bfb/internal/provider"
)

type candidateBinding struct {
	SchemaVersion  int    `json:"schema_version"`
	Version        string `json:"version"`
	StateDirectory string `json:"state_directory"`
	Home           string `json:"home"`
	BinaryPath     string `json:"binary_path"`
	BinaryHash     string `json:"binary_hash"`
	ProbeHash      string `json:"probe_hash"`
}

var candidateHash = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var candidateState = regexp.MustCompile(`^/tmp/bfb-l04-l07-[A-Za-z0-9]+/state$`)

func decodeBinding(data []byte) (candidateBinding, error) {
	var binding candidateBinding
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if len(data) > 4096 || decoder.Decode(&binding) != nil || decoder.Decode(new(any)) != io.EOF || binding.SchemaVersion != 1 || binding.Version != candidateVersion || !candidateState.MatchString(binding.StateDirectory) || !candidateHash.MatchString(binding.BinaryHash) || !candidateHash.MatchString(binding.ProbeHash) {
		return candidateBinding{}, provider.Failure("provider_config_invalid")
	}
	for _, path := range []string{binding.StateDirectory, binding.Home, binding.BinaryPath} {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path || len(path) > 4096 || strings.ContainsAny(path, "\x00\r\n") {
			return candidateBinding{}, provider.Failure("provider_path_unsafe")
		}
	}
	return binding, nil
}

func loadBinding(ctx context.Context) (candidateBinding, error) {
	if runtime.GOOS != "darwin" {
		return candidateBinding{}, provider.Failure("provider_unsupported")
	}
	executable, err := os.Executable()
	if err != nil {
		return candidateBinding{}, provider.Failure("provider_path_unsafe")
	}
	app, err := candidateBundle(executable)
	if err != nil {
		return candidateBinding{}, err
	}
	contents := filepath.Join(app, "Contents")
	verification, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	// Resource integrity is checked before it can choose a state directory.
	if exec.CommandContext(verification, "/usr/bin/codesign", "--verify", "--deep", "--strict", app).Run() != nil {
		return candidateBinding{}, provider.Failure("provider_changed")
	}
	read := func(name string) ([]byte, error) {
		file, err := os.Open(filepath.Join(contents, "Resources", name))
		if err != nil {
			return nil, err
		}
		defer file.Close()
		return io.ReadAll(io.LimitReader(file, 4097))
	}
	data, err := read("claude-candidate.json")
	if err != nil {
		return candidateBinding{}, provider.Failure("provider_config_invalid")
	}
	binding, err := decodeBinding(data)
	if err != nil {
		return candidateBinding{}, err
	}
	state, err := read("native-test-state.json")
	var resource struct {
		Directory string `json:"directory"`
	}
	if err != nil || json.Unmarshal(state, &resource) != nil || resource.Directory != binding.StateDirectory {
		return candidateBinding{}, provider.Failure("provider_config_invalid")
	}
	home, err := os.UserHomeDir()
	if err != nil || home != binding.Home {
		return candidateBinding{}, provider.Failure("provider_path_unsafe")
	}
	stamp, err := provider.FingerprintExecutable(binding.BinaryPath)
	if err != nil || stamp.CanonicalPath != binding.BinaryPath || stamp.Hash != binding.BinaryHash {
		return candidateBinding{}, provider.Failure("provider_changed")
	}
	return binding, nil
}

func candidateBundle(executable string) (string, error) {
	canonical, err := filepath.EvalSymlinks(executable)
	if err != nil || !filepath.IsAbs(canonical) || filepath.Base(canonical) != "bfb" || filepath.Base(filepath.Dir(canonical)) != "Helpers" || filepath.Base(filepath.Dir(filepath.Dir(canonical))) != "Contents" {
		return "", provider.Failure("provider_path_unsafe")
	}
	app := filepath.Dir(filepath.Dir(filepath.Dir(canonical)))
	if !strings.HasSuffix(app, ".app") {
		return "", provider.Failure("provider_path_unsafe")
	}
	return app, nil
}

func fixedArguments(binding candidateBinding, arguments []string) ([]string, error) {
	words := append([]string{}, arguments...)
	if len(words) >= 2 && words[0] == "--data-dir" && words[1] == binding.StateDirectory {
		words = words[2:]
	}
	commands := []string{}
	for _, word := range words {
		if word == "--" || word == "--data-dir" || strings.HasPrefix(word, "--data-dir=") {
			return nil, provider.Failure("unsafe_state")
		}
		if word != "--json" {
			commands = append(commands, word)
		}
	}
	normalized := strings.Join(commands, " ")
	if normalized == "daemon install" || strings.HasPrefix(normalized, "daemon install ") {
		return nil, provider.Failure("provider_unsupported")
	}
	return append([]string{"--data-dir", binding.StateDirectory}, words...), nil
}

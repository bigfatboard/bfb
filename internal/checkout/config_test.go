// ABOUTME: Shares canonical policy fixtures with the cloud and exercises fail-closed YAML parsing.
// ABOUTME: Proves file safety, inherited ceilings and immutable claimed hashes without leaking contents.

package checkout

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func TestSharedPolicyContract(t *testing.T) {
	data, err := os.ReadFile("../../protocol/fixtures/checkout-policy.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Fixtures []struct {
			Name, YAML, Canonical, Hash, Error string
			Parent, Effective                  Policy
		}
	}
	if err = json.Unmarshal(data, &contract); err != nil {
		t.Fatal(err)
	}
	if len(contract.Fixtures) < 5 {
		t.Fatal("missing policy cases")
	}
	for _, fixture := range contract.Fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			config, err := ParseRepositoryConfig([]byte(fixture.YAML))
			if err != nil {
				t.Fatal(err)
			}
			if config.Canonical != fixture.Canonical || config.Hash != fixture.Hash {
				t.Fatalf("canonical/hash mismatch: %s %s", config.Canonical, config.Hash)
			}
			effective, err := config.CheckExecution(fixture.Hash, fixture.Parent)
			if fixture.Error != "" {
				requireFailure(t, err, fixture.Error)
				return
			}
			if err != nil || !reflect.DeepEqual(effective, fixture.Effective) {
				t.Fatalf("effective: %+v %v", effective, err)
			}
			_, err = config.CheckExecution(digest("old"), fixture.Parent)
			requireFailure(t, err, "checkout_config_changed")
			config.Canonical = "{} "
			_, err = config.Tighten(fixture.Parent)
			requireFailure(t, err, "checkout_config_invalid")
		})
	}
}

func TestRepositoryConfigRejectsAmbiguityAndSecrets(t *testing.T) {
	for _, input := range []string{
		"null", "[]", "true", "allow_pass_to_agent: true\nallow_pass_to_agent: false",
		"allow_pass_to_agent: TRUE", "allow_pass_to_agent: yes", "allow_pass_to_agent: \"false\"",
		"allow_pass_to_agent: 0", "allowed_providers: codex", "allowed_providers: [unknown]",
		"allowed_providers: [false]", "allowed_providers: &x [codex]",
		"allowed_providers: *x", "provider_token: synthetic-secret", "path: /synthetic/private",
		"{} \n---\n{}", "1: false", "allow_pass_to_agent: !custom false",
		"allowed_providers: [[[[[[[[[[[codex]]]]]]]]]]]", strings.Repeat("#", MaxConfigBytes+1),
	} {
		_, err := ParseRepositoryConfig([]byte(input))
		requireFailure(t, err, "checkout_config_invalid")
		if strings.Contains(err.Error(), "synthetic") {
			t.Fatal("config content leaked")
		}
	}
	for _, input := range []string{"", "# absent\n", "{}"} {
		config, err := ParseRepositoryConfig([]byte(input))
		if err != nil || config.Canonical != "{}" {
			t.Fatalf("empty: %v", err)
		}
	}
}

func TestRepositoryConfigFilesystemSafety(t *testing.T) {
	for _, kind := range []string{"missing", "missing-file", "symlink-directory", "symlink-file", "fifo", "directory-file", "oversized", "valid"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			directory := filepath.Join(root, ".bfb")
			target := filepath.Join(root, "synthetic-secret")
			writeFixture(t, target, "allow_pass_to_agent: false\n", 0600)
			if kind != "missing" && kind != "symlink-directory" {
				must(t, os.Mkdir(directory, 0700))
			}
			configPath := filepath.Join(directory, "config.yaml")
			switch kind {
			case "symlink-directory":
				must(t, os.Symlink(root, directory))
			case "symlink-file":
				must(t, os.Symlink(target, configPath))
			case "fifo":
				must(t, unix.Mkfifo(configPath, 0600))
			case "directory-file":
				must(t, os.Mkdir(configPath, 0700))
			case "oversized":
				writeFixture(t, configPath, strings.Repeat("#", MaxConfigBytes+1), 0600)
			case "valid":
				writeFixture(t, configPath, "allow_pass_to_agent: false\n", 0600)
			}
			config, err := readRepositoryConfig(root)
			switch kind {
			case "missing", "missing-file", "valid":
				if err != nil || config.Hash == "" {
					t.Fatal(err)
				}
			case "oversized":
				requireFailure(t, err, "checkout_config_invalid")
			default:
				requireFailure(t, err, "checkout_path_unsafe")
			}
			after, err := os.ReadFile(target)
			if err != nil || string(after) != "allow_pass_to_agent: false\n" {
				t.Fatal("unsafe target mutated")
			}
		})
	}
}

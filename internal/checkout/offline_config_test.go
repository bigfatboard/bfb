// ABOUTME: Proves repository offline settings match cloud canonical bytes without changing launch policy.
// ABOUTME: Shared synthetic fixtures and YAML ambiguity cases enforce complete bounded permission parsing.

package checkout

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestOfflineRepositoryConfigContract(t *testing.T) {
	data, err := os.ReadFile("testdata/offline-agent-work.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Fixtures []struct {
			Name, YAML, Canonical, Hash, Error string
		}
	}
	if err = json.Unmarshal(data, &contract); err != nil {
		t.Fatal(err)
	}
	if len(contract.Fixtures) < 20 {
		t.Fatal("missing offline policy cases")
	}
	parent := Policy{
		AllowedProviders:      []string{"claude", "codex", "fake", "grok"},
		AllowAgentRootPropose: true, AllowPassToAgent: true, AllowRunOverrides: true,
	}
	for _, fixture := range contract.Fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			config, err := ParseRepositoryConfig([]byte(fixture.YAML))
			if fixture.Error != "" {
				requireFailure(t, err, "checkout_config_invalid")
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if config.Canonical != fixture.Canonical || config.Hash != fixture.Hash {
				t.Fatalf("canonical/hash mismatch: %s %s", config.Canonical, config.Hash)
			}
			if _, err = config.CheckExecution(fixture.Hash, parent); err != nil {
				t.Fatal(err)
			}
			// Canonical stored JSON must reparse with the same normalized document/hash.
			stored, err := ParseRepositoryConfig([]byte(fixture.Canonical))
			if err != nil || !reflect.DeepEqual(stored, config) {
				t.Fatalf("stored repository config changed: %+v %v", stored, err)
			}
		})
	}
}

func TestOfflineRepositoryConfigPreservesLaunchProjection(t *testing.T) {
	parent := Policy{AllowedProviders: []string{"codex"}, AllowPassToAgent: true}
	const frozen = `{"allowed_providers":["codex"],"allow_agent_root_propose":false,"allow_pass_to_agent":true,"allow_run_overrides":false}`
	for _, input := range []string{
		"{}",
		"offline_agent_work: {allowed_tools: [], max_pending_age_seconds: 0}",
		"offline_agent_work: {allowed_tools: [bfb_add_comment], max_pending_age_seconds: 300}",
	} {
		config, err := ParseRepositoryConfig([]byte(input))
		if err != nil {
			t.Fatal(err)
		}
		effective, err := config.Tighten(parent)
		if err != nil || !reflect.DeepEqual(effective, parent) {
			t.Fatalf("offline setting changed execution policy: %+v %v", effective, err)
		}
		encoded, err := json.Marshal(effective)
		if err != nil || string(encoded) != frozen {
			t.Fatalf("frozen launch projection changed: %s %v", encoded, err)
		}
		if input == "{}" {
			if _, present := config.document["offline_agent_work"]; present {
				t.Fatal("omitted offline permission was reconstructed")
			}
		}
	}
}

func TestOfflineRepositoryConfigRejectsYAMLAmbiguity(t *testing.T) {
	for _, input := range []string{
		"offline_agent_work: {allowed_tools: [], allowed_tools: [], max_pending_age_seconds: 0}",
		"offline_agent_work: {allowed_tools: [], max_pending_age_seconds: 0, max_pending_age_seconds: 0}",
		"offline_agent_work: {allowed_tools: [], max_pending_age_seconds: 0}\noffline_agent_work: {allowed_tools: [], max_pending_age_seconds: 0}",
		"offline_agent_work: {allowed_tools: &tools [], max_pending_age_seconds: 0}",
		"offline_agent_work: &permission {allowed_tools: [], max_pending_age_seconds: 0}",
		"offline_agent_work: *permission",
		"offline_agent_work: !permission {allowed_tools: [], max_pending_age_seconds: 0}",
		"offline_agent_work: {allowed_tools: [!tool bfb_add_comment], max_pending_age_seconds: 1}",
		"offline_agent_work: {allowed_tools: [], max_pending_age_seconds: .nan}",
		"offline_agent_work: {allowed_tools: [], max_pending_age_seconds: .inf}",
		"offline_agent_work: {allowed_tools: [], max_pending_age_seconds: -.inf}",
		"offline_agent_work: {allowed_tools: [], max_pending_age_seconds: 1e1000}",
	} {
		_, err := ParseRepositoryConfig([]byte(input))
		requireFailure(t, err, "checkout_config_invalid")
	}
}

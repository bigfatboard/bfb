// ABOUTME: Checks result-specific repository permission against shared cloud canonical hash fixtures.
// ABOUTME: Preserves frozen launch projection and rejects ambiguous or malformed result permission YAML.

package checkout

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestOfflineResultRepositoryConfigContract(t *testing.T) {
	data, err := os.ReadFile("testdata/offline-agent-results.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Fixtures []struct{ Name, YAML, Canonical, Hash, Error string }
	}
	if json.Unmarshal(data, &contract) != nil || len(contract.Fixtures) < 20 {
		t.Fatal("missing result config fixtures")
	}
	for _, fixture := range contract.Fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			config, err := ParseRepositoryConfig([]byte(fixture.YAML))
			if fixture.Error != "" {
				requireFailure(t, err, "checkout_config_invalid")
				return
			}
			if err != nil || config.Canonical != fixture.Canonical || config.Hash != fixture.Hash {
				t.Fatal("canonical/hash mismatch", config, err)
			}
			stored, err := ParseRepositoryConfig([]byte(fixture.Canonical))
			if err != nil || !reflect.DeepEqual(stored, config) {
				t.Fatal("stored normalization changed", err)
			}
		})
	}
}

func TestOfflineResultRepositoryConfigPreservesLaunchProjection(t *testing.T) {
	parent := Policy{AllowedProviders: []string{"codex"}, AllowPassToAgent: true}
	const frozen = `{"allowed_providers":["codex"],"allow_agent_root_propose":false,"allow_pass_to_agent":true,"allow_run_overrides":false}`
	for _, yaml := range []string{"{}", "offline_agent_results: {allow_submit_result: false, max_pending_age_seconds: 0}", "offline_agent_results: {allow_submit_result: true, max_pending_age_seconds: 300}"} {
		config, err := ParseRepositoryConfig([]byte(yaml))
		if err != nil {
			t.Fatal(err)
		}
		projection, err := config.Tighten(parent)
		if err != nil || !reflect.DeepEqual(projection, parent) {
			t.Fatal("execution projection changed", err)
		}
		bytes, _ := json.Marshal(projection)
		if string(bytes) != frozen {
			t.Fatal("frozen launch bytes changed", string(bytes))
		}
		if yaml == "{}" && config.Canonical != "{}" {
			t.Fatal("omitted permission reconstructed")
		}
	}
}

func TestOfflineResultRepositoryConfigRejectsAmbiguity(t *testing.T) {
	for _, yaml := range []string{
		"offline_agent_results: {allow_submit_result: false, allow_submit_result: false, max_pending_age_seconds: 0}",
		"offline_agent_results: {allow_submit_result: false, max_pending_age_seconds: 0, max_pending_age_seconds: 0}",
		"offline_agent_results: {allow_submit_result: false, max_pending_age_seconds: 0}\noffline_agent_results: {allow_submit_result: false, max_pending_age_seconds: 0}",
		"offline_agent_results: &permission {allow_submit_result: false, max_pending_age_seconds: 0}",
		"offline_agent_results: *permission", "offline_agent_results: !permission {allow_submit_result: false, max_pending_age_seconds: 0}",
		"offline_agent_results: {allow_submit_result: TRUE, max_pending_age_seconds: 1}",
		"offline_agent_results: {allow_submit_result: true, max_pending_age_seconds: .nan}",
		"offline_agent_results: {allow_submit_result: true, max_pending_age_seconds: .inf}",
		"offline_agent_results: {allow_submit_result: true, max_pending_age_seconds: 1e1000}",
	} {
		_, err := ParseRepositoryConfig([]byte(yaml))
		requireFailure(t, err, "checkout_config_invalid")
	}
}

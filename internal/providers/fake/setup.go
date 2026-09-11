// ABOUTME: Owns only the synthetic provider's top-level BFB integration namespace.
// ABOUTME: Canonicalizes unrelated JSON semantics to demonstrate setup preservation checks.

package fake

import (
	"encoding/json"
	"github.com/qdis/bfb/internal/provider"
)

type ConfigEditor struct{}

func configObject(raw []byte) (map[string]json.RawMessage, error) {
	object := map[string]json.RawMessage{}
	if len(raw) > 0 {
		if err := provider.DecodeJSON(raw, &object); err != nil || object == nil {
			return nil, provider.Failure("provider_config_invalid")
		}
	}
	return object, nil
}

func (ConfigEditor) Prepare(before []byte) ([]byte, provider.OwnedDiff, error) {
	object, err := configObject(before)
	if err != nil {
		return nil, provider.OwnedDiff{}, err
	}
	previous := object["bfb"]
	if previous == nil {
		previous = json.RawMessage("null")
	}
	next := json.RawMessage(`{"integration_version":1,"launcher":"bfb"}`)
	object["bfb"] = next
	after, err := json.Marshal(object)
	return after, provider.OwnedDiff{Namespace: "bfb", Before: previous, After: next}, err
}

func (ConfigEditor) UnownedSemantics(raw []byte) ([]byte, error) {
	object, err := configObject(raw)
	if err != nil {
		return nil, err
	}
	delete(object, "bfb")
	// Decode values as well, so insignificant formatting and key order are not edits.
	encoded, _ := json.Marshal(object)
	var values map[string]any
	if err := provider.DecodeJSON(encoded, &values); err != nil {
		return nil, err
	}
	return json.Marshal(values)
}

// ABOUTME: Decodes bounded provider JSON while rejecting ambiguous duplicate keys and deep structures.
// ABOUTME: Keeps hook and configuration parsing deterministic before provider-local field selection.

package provider

import (
	"bytes"
	"encoding/json"
	"io"
	"unicode/utf8"
)

func DecodeJSON(raw []byte, target any) error {
	return decodeJSON(raw, target, maxConfigBytes)
}

func decodeJSON(raw []byte, target any, limit int) error {
	if len(raw) == 0 || len(raw) > limit || !utf8.Valid(raw) {
		return Failure("provider_event_invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var visit func(int) error
	visit = func(depth int) error {
		if depth > 64 {
			return Failure("provider_event_invalid")
		}
		token, err := decoder.Token()
		if err != nil {
			return Failure("provider_event_invalid")
		}
		if delimiter, ok := token.(json.Delim); ok {
			switch delimiter {
			case '{':
				keys := map[string]bool{}
				for decoder.More() {
					key, err := decoder.Token()
					name, ok := key.(string)
					if err != nil || !ok || keys[name] {
						return Failure("provider_event_invalid")
					}
					keys[name] = true
					if err := visit(depth + 1); err != nil {
						return err
					}
				}
			case '[':
				for decoder.More() {
					if err := visit(depth + 1); err != nil {
						return err
					}
				}
			default:
				return Failure("provider_event_invalid")
			}
			if _, err := decoder.Token(); err != nil {
				return Failure("provider_event_invalid")
			}
		}
		return nil
	}
	if err := visit(0); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return Failure("provider_event_invalid")
	}
	decoder = json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(target) != nil {
		return Failure("provider_event_invalid")
	}
	return nil
}

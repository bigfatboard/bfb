// ABOUTME: Parses bounded single-line provider version output without inferring capabilities from help.
// ABOUTME: Rejects ambiguous versions so only explicit manifest versions can become healthy probes.

package provider

import (
	"bytes"
	"strings"
)

func ParseVersion(prefix, suffix string) func([]byte) (string, error) {
	return func(raw []byte) (string, error) {
		if len(raw) > 256 || bytes.IndexByte(raw, 0) >= 0 {
			return "", Failure("provider_probe_failed")
		}
		value := strings.TrimSpace(string(raw))
		if !strings.HasPrefix(value, prefix) || !strings.HasSuffix(value, suffix) {
			return "", Failure("provider_probe_failed")
		}
		value = strings.TrimSuffix(strings.TrimPrefix(value, prefix), suffix)
		if !versionPattern.MatchString(value) {
			return "", Failure("provider_probe_failed")
		}
		return value, nil
	}
}

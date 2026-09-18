// ABOUTME: Gates destructive commands on explicit confirm plus a fresh browser proof.
// ABOUTME: Proofs travel in files only; the handoff descriptor never invents a URL.

package humancli

import (
	"os"
	"strings"
)

// StepUp describes one destructive invocation's fresh-proof requirement.
type StepUp struct {
	Action string
	Target string
}

// Handoff renders the browser step-up descriptor the human completes out of band.
func (s StepUp) Handoff() string {
	return "complete a fresh browser step-up for action " + s.Action +
		" target " + s.Target +
		" within its 15-minute bound, then pass --step-up-proof or --step-up-proof-file"
}

// ResolveProof loads the proof ID from a flag value or a private proof file.
func ResolveProof(value, file string) (string, *Failure) {
	if value != "" && file != "" {
		return "", fail("invalid_request", "pass exactly one of --step-up-proof or --step-up-proof-file")
	}
	if file != "" {
		info, err := os.Stat(file)
		if err != nil || !info.Mode().IsRegular() || info.Size() > 4096 {
			return "", fail("invalid_request", "the proof file is unavailable")
		}
		content, err := os.ReadFile(file)
		if err != nil {
			return "", fail("invalid_request", "the proof file is unavailable")
		}
		value = strings.TrimSpace(string(content))
	}
	if value == "" {
		return "", nil
	}
	return value, nil
}

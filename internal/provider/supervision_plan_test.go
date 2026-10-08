// ABOUTME: Verifies root supervision remains a locally compiled interactive lifecycle choice.
// ABOUTME: Rejects unsupported lifecycle modes before a provider invocation becomes executable.

package provider

import (
	"testing"

	"github.com/qdis/bfb/internal/protocol/generated"
)

func TestPlanRootSupervisionBoundary(t *testing.T) {
	for _, test := range []struct {
		name, mode, supervision string
		accept                  bool
	}{
		{"default", "headless", "", true},
		{"root", "interactive", RootSupervision, true},
		{"unknown", "interactive", "unrestricted", false},
		{"headless", "headless", RootSupervision, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			plan, err := makePlan(Probe{}, LaunchInput{Config: generated.ExecutionConfig{Mode: test.mode}}, Invocation{SupervisionMode: test.supervision})
			if test.accept {
				if err != nil || plan.SupervisionMode() != test.supervision {
					t.Fatal("local supervision choice was not retained", plan.SupervisionMode(), err)
				}
			} else if err == nil {
				t.Fatal("unsupported supervision choice accepted")
			}
		})
	}
}

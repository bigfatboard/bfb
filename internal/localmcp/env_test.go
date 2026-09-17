// ABOUTME: Proves scoped environment parsing accepts the nine BFB values and refuses bearers.
// ABOUTME: Uses synthetic values only; no case reads the real process environment.

package localmcp

import (
	"testing"
)

func environOf(t *testing.T) []string {
	t.Helper()
	return []string{
		"BFB_WORKSPACE_ID=01SYNTHETICWS00000000000001",
		"BFB_PROJECT_ID=01SYNTHETICPR00000000000001",
		"BFB_TASK_ID=01SYNTHETICTA00000000000001",
		"BFB_RUN_ID=01SYNTHETICRU00000000000001",
		"BFB_RUN_EXECUTION_ID=01SYNTHETICEX00000000000001",
		"BFB_ASSIGNMENT_GENERATION=7",
		"BFB_CHECKOUT_ID=01SYNTHETICCO00000000000001",
		"BFB_CORRELATION_TOKEN=synthetic-correlation-token-for-tests-only-001",
		"BFB_ARTIFACTS_DIR=/tmp/synthetic-artifacts",
		"BFB_RUNNER_ID=01SYNTHETICRN00000000000001",
		"PATH=/usr/bin:/bin",
	}
}

func TestParseEnvAcceptsScopedValues(t *testing.T) {
	env, err := ParseEnv(environOf(t), 501)
	if err != nil {
		t.Fatal(err)
	}
	if env.Generation != 7 || env.RunID != "01SYNTHETICRU00000000000001" || env.DaemonUID != 501 {
		t.Fatalf("parsed env lost values: %+v", env)
	}
}

func TestParseEnvRefusesBearerMaterial(t *testing.T) {
	bearers := [][]string{
		append(environOf(t), "BFB_RUNNER_TOKEN=secret-value"),
		append(environOf(t), "BFB_OAUTH_SECRET=secret-value"),
		append(environOf(t), "BFB_API_BEARER=secret-value"),
		append(environOf(t), "BFB_SIGNING_KEY=secret-value"),
	}
	for index, environ := range bearers {
		if _, err := ParseEnv(environ, 501); err == nil {
			t.Fatalf("bearer case %d started with a credential in env", index)
		}
	}
}

func TestParseEnvRejectsMalformed(t *testing.T) {
	base := environOf(t)
	missing := append(append([]string{}, base[:5]...), base[6:]...)
	if _, err := ParseEnv(missing, 501); err == nil {
		t.Fatalf("missing execution ID parsed")
	}
	for _, generation := range []string{"0", "seven", "-3", "7.5"} {
		mutated := append([]string{}, base...)
		for index, entry := range mutated {
			if len(entry) > 26 && entry[:26] == "BFB_ASSIGNMENT_GENERATION=" {
				mutated[index] = "BFB_ASSIGNMENT_GENERATION=" + generation
			}
		}
		if _, err := ParseEnv(mutated, 501); err == nil {
			t.Fatalf("generation %q parsed", generation)
		}
	}
	escaped := append([]string{}, base...)
	for index, entry := range escaped {
		if len(entry) > 12 && entry[:12] == "BFB_TASK_ID=" {
			escaped[index] = "BFB_TASK_ID=../../escape"
		}
	}
	if _, err := ParseEnv(escaped, 501); err == nil {
		t.Fatalf("escaping task ID parsed")
	}
}

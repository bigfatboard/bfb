// ABOUTME: Rejects native Terminal routing on unsupported execution platforms.
// ABOUTME: Keeps portable supervisor tests from claiming a macOS GUI capability.

//go:build !darwin

package supervisor

func controllingTTY(Process) (string, error) {
	return "", failure("app_unavailable")
}

// ABOUTME: Withholds native Terminal foreground restoration on unsupported builds.
// ABOUTME: Prevents portable compilation from being mistaken for macOS execution certification.

//go:build !darwin || !cgo

package supervisor

func RestoreForeground(_, _, _ int) (bool, error) {
	return false, failure("platform_unavailable")
}

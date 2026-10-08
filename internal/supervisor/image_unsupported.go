// ABOUTME: Withholds native provider-image evidence where Darwin code validation is unavailable.
// ABOUTME: Keeps portable builds from treating filesystem paths or process presence as provider startup.

//go:build !darwin || !cgo

package supervisor

func nativeExecutable(int) (string, error) { return "", failure("platform_unavailable") }

// ABOUTME: Defines bounded D02 delivery failures without echoing peer text, paths, or credentials.
// ABOUTME: Every rejection carries a stable code so recovery can distinguish retryable from terminal states.

package discussion

import (
	"errors"

	"github.com/qdis/bfb/internal/daemon"
)

func failure(code string) error { return &daemon.Failure{Code: code} }

// Code returns the bounded D02 failure code for any error.
func Code(err error) string {
	var failure *daemon.Failure
	if errors.As(err, &failure) && failure.Code != "" {
		return failure.Code
	}
	return "internal_error"
}

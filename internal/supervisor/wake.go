// ABOUTME: Redeems opaque wake hints through existing bound enrollment connections without creating launch authority.
// ABOUTME: Bounds concurrent redemption and only reconnects the matching runner to pull its durable commands.

package supervisor

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"sync"

	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
)

func (service *Service) Wake(ctx context.Context, intent string) error {
	body, err := wireJSON("launch-wake-redemption", generated.LaunchWakeRedemption{SchemaVersion: 1, WakeIntentId: intent})
	if err != nil {
		return failure("invalid_request")
	}
	// A URL contains no trusted routing information. One bounded batch may try
	// the at-most-sixteen existing enrollments; no raw hint is retained or logged.
	if service.options.Connection == nil || service.options.WakeRunner == nil || !service.wakeMu.TryLock() {
		return failure("execution_authorization_failed")
	}
	defer service.wakeMu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, finalRequestLimit)
	defer cancel()
	if service.waitReady(ctx) != nil {
		return failure("execution_authorization_failed")
	}
	service.mu.RLock()
	defer service.mu.RUnlock()
	if service.store == nil {
		return failure("execution_authorization_failed")
	}
	enrollments := runner.NewStore(service.store.db)
	known, err := enrollments.List(ctx)
	if err != nil {
		return failure("execution_authorization_failed")
	}
	matched := make(chan runner.Enrollment, len(known))
	var requests sync.WaitGroup
	for _, enrollment := range known {
		if enrollment.State == "revoked" || enrollment.TokenEpoch < 1 || enrollment.Thumbprint == "" {
			continue
		}
		connection, err := service.options.Connection(enrollment.RunnerID)
		if err != nil || connection == nil {
			continue
		}
		requests.Go(func() {
			data, err := requestLaunch(ctx, connection, "wake/redeem", body)
			if err == nil && validWakeReceipt(data, enrollment.RunnerID) {
				matched <- enrollment
			}
		})
	}
	requests.Wait()
	if ctx.Err() != nil || len(matched) != 1 {
		return failure("execution_authorization_failed")
	}
	enrollment := <-matched
	current, err := enrollments.Get(ctx, enrollment.RunnerID)
	if err != nil || ctx.Err() != nil || current.State == "revoked" || current.WorkspaceID != enrollment.WorkspaceID || current.Origin != enrollment.Origin || current.Thumbprint != enrollment.Thumbprint {
		return failure("execution_authorization_failed")
	}
	if service.options.WakeRunner(enrollment.RunnerID) != nil {
		return failure("execution_authorization_failed")
	}
	return nil
}

// C09 returns an unversioned two-field hint receipt, not a launch specification.
// Token decoding rejects duplicate, additional, non-string and trailing values.
func validWakeReceipt(data []byte, runnerID string) bool {
	if len(data) == 0 || len(data) > 1024 {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	first, err := decoder.Token()
	if err != nil || first != json.Delim('{') {
		return false
	}
	fields := map[string]string{}
	for range 2 {
		key, err := decoder.Token()
		if err != nil || (key != "launch_id" && key != "runner_id") {
			return false
		}
		name := key.(string)
		value, err := decoder.Token()
		id, ok := value.(string)
		if err != nil || !ok || !executionID.MatchString(id) || fields[name] != "" {
			return false
		}
		fields[name] = id
	}
	last, err := decoder.Token()
	if err != nil || last != json.Delim('}') {
		return false
	}
	_, err = decoder.Token()
	return err == io.EOF && fields["runner_id"] == runnerID
}

// ABOUTME: Drains observations, inbox captures and journal uploads on a bounded daemon loop.
// ABOUTME: Wakes on ingest; every bound keeps hook latency independent of cloud availability.

package journal

import (
	"context"
	"database/sql"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/provider"
)

// Backend supplies assignment and observation views over the daemon database.
// Production adapts the supervisor intent store; the journal never owns it.
type Backend func(db *sql.DB) (Assignments, Observers)

// ServiceOptions wires the journal service without giving it command or
// credential authority. Connections stay owned by the runner manager.
type ServiceOptions struct {
	Providers  *provider.Registry
	Backend    Backend
	Connection func(runnerID string) (Connection, error)
	Now        func() time.Time
	Interval   time.Duration
}

// Service runs the periodic journal drain inside the daemon.
type Service struct {
	options ServiceOptions
	wake    chan struct{}
}

// NewService builds the journal drain service.
func NewService(options ServiceOptions) *Service {
	return &Service{options: options, wake: make(chan struct{}, 1)}
}

// Kick wakes the drain loop after a hook journals a new event.
func (service *Service) Kick() {
	select {
	case service.wake <- struct{}{}:
	default:
	}
}

// Start runs the drain loop until the daemon context ends.
func (service *Service) Start(ctx context.Context, store *daemon.Store) (func(), error) {
	if service.options.Providers == nil || service.options.Backend == nil || service.options.Connection == nil {
		return nil, failure("invalid_request")
	}
	assignments, observers := service.options.Backend(store.DB)
	journal := NewStore(store.DB)
	uploader := &Uploader{Store: journal, Lookup: service.options.Connection}
	if service.options.Now != nil {
		uploader.Now = service.options.Now
	}
	interval := service.options.Interval
	if interval <= 0 {
		interval = 5 * time.Second
	}
	runCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			service.drain(runCtx, journal, assignments, observers, uploader, store.Paths.Root)
			select {
			case <-runCtx.Done():
				return
			case <-ticker.C:
			case <-service.wake:
			}
		}
	}()
	return func() {
		cancel()
		<-done
	}, nil
}

func (service *Service) drain(ctx context.Context, journal *Store, assignments Assignments, observers Observers, uploader *Uploader, root string) {
	now := time.Now()
	if service.options.Now != nil {
		now = service.options.Now()
	}
	bounded, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	_, _, _ = journal.ImportObservations(bounded, assignments, observers, 256, now)
	_, _ = journal.ImportInbox(bounded, assignments, service.options.Providers, root, maxInboxFiles, now)
	_, _, _ = uploader.UploadOnce(bounded)
}

// RegisterService exposes the journal drain as a daemon service.
func RegisterService(registry *daemon.Registry, service *Service) error {
	return registry.RegisterService("journal", service.Start)
}

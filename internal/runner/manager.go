// ABOUTME: Owns one cancellable background lifecycle per durable workspace enrollment.
// ABOUTME: Recovers isolated key creation and credentials without depending on the macOS app's lifetime.

package runner

import (
	"context"
	"errors"
	"math/rand/v2"
	"net/http"
	"sync"
	"time"

	"github.com/qdis/bfb/internal/auth"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/notify"
)

type enrollmentWorker struct {
	done       chan struct{}
	wake       chan struct{}
	connection *Connection
}

type Manager struct {
	mu          sync.Mutex
	ctx         context.Context
	cancel      context.CancelFunc
	store       *Store
	credentials Credentials
	client      *http.Client
	workers     map[string]*enrollmentWorker
	consumers   map[string]CommandConsumer
	inventory   InventorySource
	heartbeat   time.Duration
	notify      *notify.Service
}

// Credentials and HTTPClient are dependency boundaries for native integration
// tests. Production has no RPC/configuration path for supplying either.
// Notifier enables macOS notification polling through the app bridge; nil
// keeps the manager exactly as before.
type ManagerOptions struct {
	Credentials Credentials
	HTTPClient  *http.Client
	Inventory   InventorySource
	Consumers   map[string]CommandConsumer
	Notifier    notify.Notifier
}

func NewManager(options ManagerOptions) *Manager {
	if options.Credentials == nil {
		options.Credentials = &auth.Keychain{}
	}
	consumers := map[string]CommandConsumer{}
	for kind, accept := range options.Consumers {
		consumers[kind] = accept
	}
	manager := &Manager{credentials: options.Credentials, client: options.HTTPClient, inventory: options.Inventory, consumers: consumers, workers: map[string]*enrollmentWorker{}, heartbeat: 20 * time.Second}
	if options.Notifier != nil {
		manager.notify = &notify.Service{
			Connections: func(runnerID string) (notify.Connection, error) {
				return manager.Connection(runnerID)
			},
			Enrollments: func(ctx context.Context) ([]notify.Enrollment, error) {
				manager.mu.Lock()
				store := manager.store
				manager.mu.Unlock()
				if store == nil {
					return nil, nil
				}
				list, err := store.List(ctx)
				if err != nil {
					return nil, err
				}
				enrollments := make([]notify.Enrollment, 0, len(list))
				for _, enrollment := range list {
					enrollments = append(enrollments, notify.Enrollment{RunnerID: enrollment.RunnerID})
				}
				return enrollments, nil
			},
			Notifier: options.Notifier,
		}
	}
	return manager
}

func (manager *Manager) Start(ctx context.Context, local *daemon.Store) (func(), error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.store != nil {
		return nil, ErrProtocol
	}
	manager.store = NewStore(local.DB)
	if err := manager.store.Recover(ctx); err != nil {
		return nil, err
	}
	enrollments, err := manager.store.List(ctx)
	if err != nil {
		return nil, err
	}
	if manager.inventory == nil {
		manager.inventory = LocalInventory(local.DB)
	}
	manager.ctx, manager.cancel = context.WithCancel(ctx)
	for _, enrollment := range enrollments {
		manager.startWorker(enrollment)
	}
	if manager.notify != nil {
		// The poll loop is scoped to the manager context and exits on Close;
		// Close must not join it while holding the manager mutex.
		manager.notify.Start(manager.ctx)
	}
	return manager.Close, nil
}

func (manager *Manager) startWorker(enrollment Enrollment) {
	if manager.workers[enrollment.RunnerID] != nil || enrollment.State == "revoked" {
		return
	}
	worker := &enrollmentWorker{done: make(chan struct{}), wake: make(chan struct{}, 1)}
	manager.workers[enrollment.RunnerID] = worker
	go func() { defer close(worker.done); manager.run(enrollment, worker) }()
}

func (manager *Manager) Close() {
	manager.mu.Lock()
	manager.cancel()
	workers := make([]*enrollmentWorker, 0, len(manager.workers))
	for _, worker := range manager.workers {
		workers = append(workers, worker)
	}
	manager.mu.Unlock()
	for _, worker := range workers {
		<-worker.done
	}
}

// Wake forces fresh online authentication after an OS wake or an explicit retry.
func (manager *Manager) Wake(runner string) error {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	worker := manager.workers[runner]
	if worker == nil {
		return ErrAuthorization
	}
	select {
	case worker.wake <- struct{}{}:
	default:
	}
	return nil
}

func (manager *Manager) Connection(runner string) (RunnerConnection, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	worker := manager.workers[runner]
	if worker == nil || worker.connection == nil {
		return nil, ErrOffline
	}
	return worker.connection, nil
}

func (manager *Manager) run(enrollment Enrollment, worker *enrollmentWorker) {
	backoff := time.Second
	for manager.ctx.Err() == nil {
		attemptCtx, cancel := context.WithCancel(manager.ctx)
		interrupted := make(chan struct{})
		go func() {
			defer close(interrupted)
			select {
			case <-worker.wake:
				cancel()
			case <-attemptCtx.Done():
			}
		}()
		started := time.Now()
		err := manager.attempt(attemptCtx, &enrollment, worker)
		if attemptCtx.Err() != nil && !errors.Is(err, ErrRevoked) {
			err = attemptCtx.Err()
		}
		cancel()
		<-interrupted
		if manager.ctx.Err() != nil {
			break
		}
		current, readErr := manager.store.Get(manager.ctx, enrollment.RunnerID)
		if readErr != nil || current.State == "revoked" || errors.Is(err, ErrRevoked) {
			return
		}
		state := "offline"
		switch {
		case len(current.PublicKey) == 0:
			state = "key_pending"
		case errors.Is(err, auth.ErrCredentialUnavailable), errors.Is(err, auth.ErrCredentialNotFound):
			state = "credential_unavailable"
		case errors.Is(err, ErrInventory), errors.Is(err, ErrProtocol):
			state = "sync_blocked"
		case errors.Is(err, ErrAuthorization):
			state = "authorization_required"
			if current.TokenEpoch == 0 {
				state = "pending_approval"
			}
		}
		if manager.store.SetState(manager.ctx, enrollment.RunnerID, state) != nil {
			return
		}
		if errors.Is(err, errRotate) || errors.Is(err, context.Canceled) {
			backoff = time.Second
			continue
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		timer := time.NewTimer(backoff + time.Duration(rand.Int64N(int64(backoff/2))))
		select {
		case <-manager.ctx.Done():
		case <-worker.wake:
		case <-timer.C:
		}
		timer.Stop()
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
	// Cancellation isn't completion, revocation or process exit.
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = manager.store.SetState(ctx, enrollment.RunnerID, "offline")
}

func (manager *Manager) attempt(ctx context.Context, enrollment *Enrollment, worker *enrollmentWorker) error {
	current, err := manager.store.Get(ctx, enrollment.RunnerID)
	if err != nil {
		return err
	}
	if current.State == "revoked" {
		return ErrRevoked
	}
	current, err = manager.store.CompleteKey(ctx, current, manager.credentials)
	if err != nil {
		return err
	}
	*enrollment = current
	if err := manager.store.SetState(ctx, current.RunnerID, "connecting"); err != nil {
		return err
	}
	connection, err := NewConnection(current, manager.credentials, manager.client, func(ctx context.Context, epoch int64) error {
		return manager.store.SaveEpoch(ctx, current.RunnerID, epoch)
	})
	if err != nil {
		return err
	}
	defer connection.Disconnect()
	if err := connection.Renew(ctx, current.TokenEpoch); err != nil {
		return err
	}
	manager.mu.Lock()
	worker.connection = connection
	manager.mu.Unlock()
	defer func() { manager.mu.Lock(); worker.connection = nil; manager.mu.Unlock() }()
	return manager.serveChannel(ctx, current, connection)
}

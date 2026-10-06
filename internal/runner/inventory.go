// ABOUTME: Produces bounded path-free checkout and provider observations for one runner's granted projects.
// ABOUTME: Uses local L02/L03 inspection and translates observation clocks without extending probe validity.

package runner

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"github.com/qdis/bfb/internal/checkout"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers"
)

var ErrInventory = errors.New("runner inventory unavailable or exceeds bounds")

type providerReport struct {
	Provider     string   `json:"provider"`
	Version      string   `json:"version"`
	ManifestID   string   `json:"manifest_id"`
	Capabilities []string `json:"capabilities"`
	Status       string   `json:"status"`
	ObservedAt   string   `json:"observed_at"`
	ExpiresAt    string   `json:"expires_at"`
}

func inventoryTimestamp(observed time.Time, offset time.Duration) string {
	// Floor after translating the clock so the frozen microsecond wire format
	// never rounds an observation or its expiry into the future.
	return observed.Add(offset).UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano)
}

func LocalInventory(db *sql.DB) InventorySource {
	return LocalInventoryWithProviders(db, nil, nil)
}

// LocalInventoryWithProviders shares compiled registry and discovery with execution.
// Nil dependencies keep production defaults; neither is remotely configurable.
func LocalInventoryWithProviders(db *sql.DB, registry *provider.Registry, installation func(context.Context, string) (provider.Installation, error)) InventorySource {
	if registry == nil {
		var err error
		registry, err = provider.NewRegistry(providers.Descriptors())
		if err != nil {
			panic("invalid compiled provider descriptors")
		}
	}
	if installation == nil {
		installation = providers.LocalInstallation
	}
	return func(ctx context.Context, enrollment Enrollment, projects []string, offset time.Duration) ([]byte, error) {
		checkouts := []generated.CheckoutSummary{}
		local := checkout.NewRegistry(db)
		after := ""
		for pageIndex := 0; pageIndex < 16; pageIndex++ {
			page, next, err := local.List(ctx, checkout.ListOptions{WorkspaceID: enrollment.WorkspaceID, RunnerID: enrollment.RunnerID, After: after, Limit: 25})
			if err != nil {
				return nil, ErrInventory
			}
			for _, previous := range page {
				if !slices.Contains(projects, previous.ProjectId) {
					continue
				}
				if len(checkouts) == 25 {
					return nil, ErrInventory
				}
				record, _ := local.Verify(ctx, previous.CheckoutId)
				// Verify returns a persisted blocked summary for identity failures.
				// If storage itself failed, no fresh observation may be advertised.
				if record.Summary.CheckoutId == "" {
					return nil, ErrInventory
				}
				observed, err := time.Parse(time.RFC3339Nano, record.Summary.ValidatedAt)
				if err != nil {
					return nil, ErrInventory
				}
				record.Summary.ValidatedAt = inventoryTimestamp(observed, offset)
				checkouts = append(checkouts, record.Summary)
			}
			if next == "" {
				break
			}
			if pageIndex == 15 || next <= after {
				return nil, ErrInventory
			}
			after = next
		}
		reports := []providerReport{}
		for _, name := range registry.Names() {
			// A fake provider is an explicit test installation, never discovered
			// from an arbitrary executable with that name in the user's PATH.
			if name == "fake" {
				continue
			}
			now := time.Now()
			report := providerReport{Provider: name, Status: "unavailable", Capabilities: []string{}, ObservedAt: inventoryTimestamp(now, offset), ExpiresAt: inventoryTimestamp(now.Add(30*time.Second), offset)}
			localInstallation, installationErr := installation(ctx, name)
			if installationErr == nil {
				probe, probeErr := registry.Probe(ctx, name, localInstallation, now)
				if probeErr == nil {
					report.Version, report.ManifestID, report.Status = probe.Version, probe.ManifestID, probe.Status
					report.Capabilities = append([]string{}, probe.Capabilities...)
					// Interactive resume is a local planner detail, not a v1 wire
					// capability. Keep the generic session.resume observation.
					report.Capabilities = slices.DeleteFunc(report.Capabilities, func(capability string) bool {
						return capability == "session.resume.interactive"
					})
					report.ObservedAt = inventoryTimestamp(probe.ObservedAt, offset)
					report.ExpiresAt = inventoryTimestamp(probe.ExpiresAt, offset)
				}
			}
			reports = append(reports, report)
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		revision, err := NewStore(db).NextInventoryRevision(ctx, enrollment.RunnerID)
		if err != nil {
			return nil, err
		}
		return json.Marshal(struct {
			Version     int                         `json:"schema_version"`
			WorkspaceID string                      `json:"workspace_id"`
			RunnerID    string                      `json:"runner_id"`
			Revision    int64                       `json:"revision"`
			Checkouts   []generated.CheckoutSummary `json:"checkouts"`
			Providers   []providerReport            `json:"providers"`
		}{1, enrollment.WorkspaceID, enrollment.RunnerID, revision, checkouts, reports})
	}
}

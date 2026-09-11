// ABOUTME: Produces bounded path-free checkout and provider observations for one runner's granted projects.
// ABOUTME: Uses local L02/L03 inspection and translates observation clocks without extending probe validity.

package runner

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
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

func LocalInventory(db *sql.DB) InventorySource {
	registry, err := provider.NewRegistry(providers.Descriptors())
	if err != nil {
		panic("invalid compiled provider descriptors")
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
				record.Summary.ValidatedAt = observed.Add(offset).UTC().Format(time.RFC3339Nano)
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
			report := providerReport{Provider: name, Status: "unavailable", Capabilities: []string{}, ObservedAt: now.Add(offset).UTC().Format(time.RFC3339Nano), ExpiresAt: now.Add(offset).Add(30 * time.Second).UTC().Format(time.RFC3339Nano)}
			path, pathErr := exec.LookPath(name)
			if pathErr == nil {
				installation := provider.Installation{Executable: path, Environment: os.Environ(), IntegrationHash: provider.Hash(nil)}
				probe, probeErr := registry.Probe(ctx, name, installation, now)
				if probeErr == nil {
					report.Version, report.ManifestID, report.Status = probe.Version, probe.ManifestID, probe.Status
					report.Capabilities = append([]string{}, probe.Capabilities...)
					report.ObservedAt = probe.ObservedAt.Add(offset).UTC().Format(time.RFC3339Nano)
					report.ExpiresAt = probe.ExpiresAt.Add(offset).UTC().Format(time.RFC3339Nano)
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

// ABOUTME: Publishes only closed synthetic checkout and provider inventory in the signed native fixture.
// ABOUTME: Refreshes bounded observation timestamps without inspecting or invoking real provider installations.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
)

func fixtureInventory(root string) runner.InventorySource {
	var revision atomic.Int64
	revision.Store(time.Now().UnixMilli())
	return func(_ context.Context, enrollment runner.Enrollment, _ []string, offset time.Duration) ([]byte, error) {
		inventory := generated.RunnerInventory{SchemaVersion: 1, WorkspaceId: enrollment.WorkspaceID, RunnerId: enrollment.RunnerID, Checkouts: []generated.CheckoutSummary{}, Providers: []map[string]any{}}
		data, err := os.ReadFile(filepath.Join(root, "fixture-inventory.json"))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		if err == nil {
			if !protocol.DecodeWireDocument("runner-inventory", data).OK || json.Unmarshal(data, &inventory) != nil || inventory.WorkspaceId != enrollment.WorkspaceID || inventory.RunnerId != enrollment.RunnerID {
				return nil, runner.ErrInventory
			}
		}
		now := time.Now().Add(offset).UTC()
		inventory.Revision = revision.Add(1)
		for index := range inventory.Checkouts {
			inventory.Checkouts[index].ValidatedAt = now.Format(time.RFC3339Nano)
		}
		for _, provider := range inventory.Providers {
			provider["observed_at"] = now.Format(time.RFC3339Nano)
			provider["expires_at"] = now.Add(30 * time.Second).Format(time.RFC3339Nano)
		}
		return json.Marshal(inventory)
	}
}

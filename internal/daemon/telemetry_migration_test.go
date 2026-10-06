// ABOUTME: Proves telemetry migration preserves frozen pending bytes and rolls back atomically.
// ABOUTME: Keeps historical untyped capture separate from newly retained semantic phase identities.

package daemon

import (
	"context"
	"errors"
	"testing"
)

func TestTelemetryMigrationPreservesV1AndRollsBack(t *testing.T) {
	ctx := context.Background()
	paths := testPaths(t)
	migrations := kernelMigrations()
	if len(migrations) != 11 || migrations[10].name != "011_measurement_telemetry.sql" {
		t.Fatal("unexpected ordered migration head")
	}
	previous, err := openStore(ctx, paths, migrations[:10], nil)
	if err != nil {
		t.Fatal(err)
	}
	original := `{"schema_version":1,"event_id":"01JBFB0EVENTXXX00000000000","source_stream_id":"01JBFB0STREAMXX00000000000","source_sequence":1,"run_execution_id":"01JBFB0EXECVTN00000000000","assignment_generation":1,"kind":"turn_started","occurred_at":"2026-10-06T00:00:00Z","capture_origin":"agent_reported","payload":{}}`
	_, err = previous.DB.Exec(`INSERT INTO hook_journal (event_id,stream_id,source_sequence,runner_id,execution_id,assignment_generation,provider,kind,occurred_at,captured_at,capture_origin,submission_json)
VALUES ('historical-event','historical-stream',1,'historical-runner','historical-execution',1,'fake','turn_started','2026-10-06T00:00:00Z','2026-10-06T00:00:00Z','agent_reported',?)`, original)
	if err != nil {
		t.Fatal(err)
	}
	if err := previous.Close(); err != nil {
		t.Fatal(err)
	}
	_, err = openStore(ctx, paths, migrations, func(version int) error {
		if version == 11 {
			return errors.New("synthetic interruption")
		}
		return nil
	})
	if AsFailure(err).Code != "storage_failed" {
		t.Fatal("interrupted migration committed", err)
	}
	previous, err = openStore(ctx, paths, migrations[:10], nil)
	if err != nil {
		t.Fatal(err)
	}
	var columns int
	if err := previous.DB.QueryRow("SELECT count(*) FROM pragma_table_info('hook_journal') WHERE name='workspace_id'").Scan(&columns); err != nil || columns != 0 {
		t.Fatal("partial telemetry column survived", err)
	}
	if err := previous.Close(); err != nil {
		t.Fatal(err)
	}
	upgraded := openTestStore(t, paths)
	defer upgraded.Close()
	var actual, workspace string
	if err := upgraded.DB.QueryRow("SELECT submission_json,workspace_id FROM hook_journal WHERE event_id='historical-event'").Scan(&actual, &workspace); err != nil || actual != original || workspace != "" {
		t.Fatal("historical bytes or attribution manufactured", err)
	}
	var identities int
	if err := upgraded.DB.QueryRow("SELECT count(*) FROM hook_telemetry_identities").Scan(&identities); err != nil || identities != 0 {
		t.Fatal("legacy semantic identities fabricated", err)
	}
	var head int
	if err := upgraded.DB.QueryRow("SELECT max(version) FROM schema_migrations").Scan(&head); err != nil || head != StorageVersion {
		t.Fatal("ordered head mismatch", err)
	}
}

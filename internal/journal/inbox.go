// ABOUTME: Captures authenticated hook envelopes while the daemon database is unreachable.
// ABOUTME: Imports them exactly once and quarantines corrupt or forged files visibly.

package journal

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/provider"
)

var providerNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)

func ownedBySelf(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Getuid())
}

const inboxDirName = "hook-inbox"
const fileQuarantineDirName = "hook-quarantine"
const maxInboxFiles = 256
const maxEnvelopeBytes = 96 * 1024

// Capture is the locally authenticated inbox envelope. The HMAC binds the raw
// hook bytes to the run-scoped correlation capability; the daemon verifies it
// against the immutable assignment before journaling.
type Capture struct {
	SchemaVersion        int    `json:"schema_version"`
	ExecutionID          string `json:"execution_id"`
	AssignmentGeneration int64  `json:"assignment_generation"`
	Provider             string `json:"provider"`
	CapturedAt           string `json:"captured_at"`
	Payload              string `json:"payload"`
	HMAC                 string `json:"hmac"`
}

func inboxDir(root string) string          { return filepath.Join(root, inboxDirName) }
func fileQuarantineDir(root string) string { return filepath.Join(root, fileQuarantineDirName) }

func privateDir(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return failure("storage_failed")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 || !ownedBySelf(info) {
		return failure("unsafe_state")
	}
	return nil
}

func captureMAC(token []byte, execution string, generation int64, provider, captured, payload string) []byte {
	mac := hmac.New(sha256.New, token)
	mac.Write([]byte(execution))
	mac.Write([]byte{'\n'})
	mac.Write([]byte(strconv.FormatInt(generation, 10)))
	mac.Write([]byte{'\n'})
	mac.Write([]byte(provider))
	mac.Write([]byte{'\n'})
	mac.Write([]byte(captured))
	mac.Write([]byte{'\n'})
	mac.Write([]byte(payload))
	return mac.Sum(nil)
}

func decodeToken(token string) ([]byte, error) {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != 32 || base64.RawURLEncoding.EncodeToString(raw) != token {
		return nil, failure("correlation_rejected")
	}
	return raw, nil
}

// WriteCapture atomically stores one authenticated envelope without touching
// the database, so a dead, locked or full database cannot lose the capture.
// Callers fall back here only for transport and storage faults, never for a
// hook the journal already validated and rejected.
func WriteCapture(root, token, execution string, generation int64, providerName string, raw []byte, capturedAt time.Time) (string, error) {
	if len(raw) == 0 || len(raw) > provider.MaxHookBytes || !providerNamePattern.MatchString(providerName) || execution == "" || generation < 1 {
		return "", failure("provider_event_invalid")
	}
	key, err := decodeToken(token)
	if err != nil {
		return "", err
	}
	if err := privateDir(inboxDir(root)); err != nil {
		return "", err
	}
	if err := privateDir(fileQuarantineDir(root)); err != nil {
		return "", err
	}
	entries, err := os.ReadDir(inboxDir(root))
	if err != nil {
		return "", failure("storage_failed")
	}
	stored := 0
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".capture.json") {
			stored++
		}
	}
	if stored >= maxInboxFiles {
		return "", failure("inbox_full")
	}
	stamp := localTimestamp(capturedAt)
	payload := base64.StdEncoding.EncodeToString(raw)
	capture := Capture{
		SchemaVersion: 1, ExecutionID: execution, AssignmentGeneration: generation,
		Provider: providerName, CapturedAt: stamp, Payload: payload,
		HMAC: base64.RawURLEncoding.EncodeToString(captureMAC(key, execution, generation, providerName, stamp, payload)),
	}
	data, err := json.Marshal(capture)
	if err != nil || len(data) > maxEnvelopeBytes {
		return "", failure("storage_failed")
	}
	name := daemon.NewRequestID() + ".capture.json"
	tmp, err := os.OpenFile(filepath.Join(inboxDir(root), "."+name+".tmp"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return "", failure("storage_failed")
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return "", failure("storage_failed")
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return "", failure("storage_failed")
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return "", failure("storage_failed")
	}
	if err := os.Rename(tmpName, filepath.Join(inboxDir(root), name)); err != nil {
		_ = os.Remove(tmpName)
		return "", failure("storage_failed")
	}
	return name, nil
}

// ImportResult counts one inbox sweep without retaining file contents.
type ImportResult struct {
	Imported    int `json:"imported"`
	Quarantined int `json:"quarantined"`
}

// ImportInbox journals every authenticated capture exactly once. Files already
// recorded in the receipt table are unlinked without re-journaling; corrupt,
// forged or stale captures move to the file quarantine with a visible reason
// and raise the telemetry-degraded state instead of vanishing silently.
func (store *Store) ImportInbox(ctx context.Context, assignments Assignments, registry *provider.Registry, root string, limit int, now time.Time) (ImportResult, error) {
	var result ImportResult
	if err := privateDir(inboxDir(root)); err != nil {
		return result, err
	}
	if err := privateDir(fileQuarantineDir(root)); err != nil {
		return result, err
	}
	entries, err := os.ReadDir(inboxDir(root))
	if err != nil {
		return result, failure("storage_failed")
	}
	names := []string{}
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".capture.json") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	if limit < 1 {
		limit = maxInboxFiles
	}
	for _, name := range names {
		if result.Imported+result.Quarantined >= limit {
			break
		}
		outcome, err := store.importFile(ctx, assignments, registry, root, name, now)
		if err != nil {
			return result, err
		}
		if outcome == "imported" {
			result.Imported++
		} else {
			result.Quarantined++
		}
	}
	if result.Quarantined == 0 {
		remaining, err := os.ReadDir(inboxDir(root))
		if err != nil {
			return result, failure("storage_failed")
		}
		pending := false
		for _, entry := range remaining {
			if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".capture.json") {
				pending = true
			}
		}
		if !pending {
			if _, err := store.db.ExecContext(ctx, "UPDATE hook_journal_meta SET value = '0' WHERE key = 'telemetry_degraded'"); err != nil {
				return result, failure("storage_failed")
			}
			if _, err := store.db.ExecContext(ctx, "UPDATE hook_journal_meta SET value = '' WHERE key = 'degraded_reason'"); err != nil {
				return result, failure("storage_failed")
			}
		}
	}
	return result, nil
}

func (store *Store) importFile(ctx context.Context, assignments Assignments, registry *provider.Registry, root, name string, now time.Time) (string, error) {
	path := filepath.Join(inboxDir(root), name)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxEnvelopeBytes {
		return store.quarantineFile(ctx, root, name, nil, "inbox_corrupt", now)
	}
	data, err := os.ReadFile(path)
	if err != nil || int64(len(data)) != info.Size() {
		return "", failure("storage_failed")
	}
	sum := sha256.Sum256(data)
	fileHash := hex.EncodeToString(sum[:])
	var recorded string
	if err := store.db.QueryRowContext(ctx, "SELECT outcome FROM hook_inbox_receipts WHERE file_hash = ?", fileHash).Scan(&recorded); err != nil && err != sql.ErrNoRows {
		return "", failure("storage_failed")
	}
	if recorded != "" {
		_ = os.Remove(path)
		return recorded, nil
	}
	var capture Capture
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&capture); err != nil {
		return store.quarantineFile(ctx, root, name, data, "inbox_corrupt", now)
	}
	if capture.SchemaVersion != 1 || capture.ExecutionID == "" || capture.AssignmentGeneration < 1 || !providerNamePattern.MatchString(capture.Provider) || capture.Payload == "" || capture.HMAC == "" {
		return store.quarantineFile(ctx, root, name, data, "inbox_corrupt", now)
	}
	raw, err := base64.StdEncoding.DecodeString(capture.Payload)
	if err != nil || len(raw) == 0 || len(raw) > provider.MaxHookBytes {
		return store.quarantineFile(ctx, root, name, data, "inbox_corrupt", now)
	}
	capturedAt, err := time.Parse(time.RFC3339Nano, capture.CapturedAt)
	if err != nil {
		return store.quarantineFile(ctx, root, name, data, "inbox_corrupt", now)
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return "", failure("storage_failed")
	}
	defer tx.Rollback()
	assignment, err := assignments.ByExecution(ctx, capture.ExecutionID, capture.AssignmentGeneration)
	if err != nil {
		if commitErr := tx.Commit(); commitErr != nil {
			return "", failure("storage_failed")
		}
		return store.quarantineFile(ctx, root, name, data, "unknown_assignment", now)
	}
	key, err := decodeToken(assignment.Token)
	if err != nil {
		if commitErr := tx.Commit(); commitErr != nil {
			return "", failure("storage_failed")
		}
		return store.quarantineFile(ctx, root, name, data, "unknown_assignment", now)
	}
	expected := captureMAC(key, capture.ExecutionID, capture.AssignmentGeneration, capture.Provider, capture.CapturedAt, capture.Payload)
	presented, err := base64.RawURLEncoding.DecodeString(capture.HMAC)
	if err != nil || !hmac.Equal(presented, expected) {
		if commitErr := tx.Commit(); commitErr != nil {
			return "", failure("storage_failed")
		}
		return store.quarantineFile(ctx, root, name, data, "inbox_auth_failed", now)
	}
	validated, code, err := validateHookData(assignments, registry, capture, raw, capturedAt, ctx)
	if err != nil {
		if asCode(err) == "storage_failed" {
			return "", err
		}
		if commitErr := tx.Commit(); commitErr != nil {
			return "", failure("storage_failed")
		}
		return store.quarantineFile(ctx, root, name, data, "hook_provider_event_invalid", now)
	}
	if validated.stamp == "" {
		if commitErr := tx.Commit(); commitErr != nil {
			return "", failure("storage_failed")
		}
		return store.quarantineFile(ctx, root, name, data, "hook_"+code, now)
	}
	input := HookInput{
		Provider: capture.Provider, Raw: raw, ExecutionID: capture.ExecutionID, Generation: capture.AssignmentGeneration,
		Token: assignment.Token, WorkspaceID: assignment.WorkspaceID, ProjectID: assignment.ProjectID,
		TaskID: assignment.TaskID, RunID: assignment.RunID, CapturedAt: capturedAt,
	}
	receipt, err := journalTx(ctx, store, tx, validated, input, now)
	if err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO hook_inbox_receipts (file_hash, execution_id, outcome, recorded_at) VALUES (?, ?, 'imported', ?)", fileHash, capture.ExecutionID, localTimestamp(now)); err != nil {
		return "", failure("storage_failed")
	}
	if err := tx.Commit(); err != nil {
		return "", failure("storage_failed")
	}
	_ = os.Remove(path)
	_ = receipt
	return "imported", nil
}

// validateHookData revalidates an inbox capture without trusting its file
// bytes: the assignment, correlation window and provider parser decide again.
func validateHookData(assignments Assignments, registry *provider.Registry, capture Capture, raw []byte, capturedAt time.Time, ctx context.Context) (validatedHook, string, error) {
	assignment, err := assignments.ByExecution(ctx, capture.ExecutionID, capture.AssignmentGeneration)
	if err != nil {
		return validatedHook{}, asCode(err), nil
	}
	input := HookInput{
		Provider: capture.Provider, Raw: raw, ExecutionID: capture.ExecutionID, Generation: capture.AssignmentGeneration,
		Token: assignment.Token, WorkspaceID: assignment.WorkspaceID, ProjectID: assignment.ProjectID,
		TaskID: assignment.TaskID, RunID: assignment.RunID, CapturedAt: capturedAt,
	}
	return validateHook(ctx, assignments, registry, input)
}

func (store *Store) quarantineFile(ctx context.Context, root, name string, data []byte, reason string, now time.Time) (string, error) {
	provider, kind, session, execution := "unknown", "unknown", "", ""
	if len(data) > 0 {
		var capture Capture
		if json.Unmarshal(data, &capture) == nil {
			execution = capture.ExecutionID
			if providerNamePattern.MatchString(capture.Provider) {
				provider = capture.Provider
			}
		}
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return "", failure("storage_failed")
	}
	defer tx.Rollback()
	var generation int64
	if len(data) > 0 {
		var capture Capture
		if json.Unmarshal(data, &capture) == nil {
			generation = capture.AssignmentGeneration
		}
	}
	if err := quarantine(ctx, tx, execution, generation, provider, kind, session, reason, localTimestamp(now), localTimestamp(now)); err != nil {
		return "", err
	}
	if len(data) > 0 {
		sum := sha256.Sum256(data)
		if _, err := tx.ExecContext(ctx, "INSERT INTO hook_inbox_receipts (file_hash, execution_id, outcome, recorded_at) VALUES (?, ?, 'quarantined', ?) ON CONFLICT(file_hash) DO NOTHING", hex.EncodeToString(sum[:]), execution, localTimestamp(now)); err != nil {
			return "", failure("storage_failed")
		}
	}
	if err := setDegraded(ctx, tx, reason, localTimestamp(now)); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", failure("storage_failed")
	}
	source := filepath.Join(inboxDir(root), name)
	if len(data) > 0 {
		sum := sha256.Sum256(data)
		_ = os.Rename(source, filepath.Join(fileQuarantineDir(root), hex.EncodeToString(sum[:])+".capture.json"))
	} else {
		_ = os.Remove(source)
	}
	return "quarantined", nil
}

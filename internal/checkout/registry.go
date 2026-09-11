// ABOUTME: Persists explicit local checkout bindings and revalidates their immutable physical identity.
// ABOUTME: Exposes sanitized observations while keeping paths local and unlink history non-destructive.

package checkout

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

const recordColumns = `id, workspace_id, runner_id, project_id, label, is_default,
registered_path, working_directory, git_root, git_directory, git_common_directory,
workspace_subpath, cwd_identity, root_identity, git_identity, common_identity,
remote_name, repository_identity, physical_worktree_hash, branch, head, dirty,
canonical_config, repository_config_hash, status, block_reason, validated_at`

type Registry struct{ db *sql.DB }

type LinkInput struct {
	WorkspaceID, RunnerID, ProjectID                              string
	Path, RepositoryIdentity, WorkspaceSubpath, RemoteName, Label string
	IsDefault                                                     bool
}

type Record struct {
	Summary    generated.CheckoutSummary `json:"summary"`
	Location   Location                  `json:"-"`
	RemoteName string                    `json:"-"`
	Config     RepositoryConfig          `json:"-"`
}

type ListOptions struct {
	WorkspaceID, RunnerID, ProjectID, After string
	Limit                                   int
}

func NewRegistry(db *sql.DB) *Registry { return &Registry{db: db} }

func optionalText(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func textValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func validSummary(summary generated.CheckoutSummary) bool {
	data, err := json.Marshal(summary)
	return err == nil && protocol.DecodeWireDocument("checkout-summary", data).OK
}

func (registry *Registry) Link(ctx context.Context, input LinkInput) (Record, error) {
	if !idPattern.MatchString(input.WorkspaceID) || !idPattern.MatchString(input.RunnerID) || !idPattern.MatchString(input.ProjectID) || !validLabel(input.Label) {
		return Record{}, failure("invalid_request")
	}
	if input.RemoteName == "" {
		input.RemoteName = "origin"
	}
	if input.WorkspaceSubpath == "" {
		input.WorkspaceSubpath = "."
	}
	expectedRepository, err := NormalizeRepositoryIdentity(input.RepositoryIdentity)
	if err != nil {
		return Record{}, err
	}
	expectedSubpath, err := normalizeSubpath(input.WorkspaceSubpath)
	if err != nil {
		return Record{}, err
	}
	observed, err := Observe(ctx, input.Path, input.RemoteName)
	if err != nil {
		return Record{}, err
	}
	if observed.RepositoryIdentity != expectedRepository {
		return Record{}, failure("checkout_repository_mismatch")
	}
	if observed.Location.WorkspaceSubpath != expectedSubpath {
		return Record{}, failure("checkout_subpath_mismatch")
	}
	record := Record{
		Summary: generated.CheckoutSummary{
			SchemaVersion: 1, CheckoutId: daemon.NewRequestID(),
			WorkspaceId: input.WorkspaceID, RunnerId: input.RunnerID, ProjectId: input.ProjectID,
			Label: input.Label, IsDefault: input.IsDefault,
			RepositoryIdentity: expectedRepository, WorkspaceSubpath: expectedSubpath,
			PhysicalWorktreeHash: observed.Location.PhysicalWorktreeHash,
		},
		Location: observed.Location, RemoteName: input.RemoteName,
	}
	record.observe(observed)
	if !validSummary(record.Summary) {
		return Record{}, failure("invalid_request")
	}
	tx, err := registry.db.BeginTx(ctx, nil)
	if err != nil {
		return Record{}, failure("storage_failed")
	}
	defer func() { _ = tx.Rollback() }()
	var existing string
	err = tx.QueryRowContext(ctx, "SELECT id FROM checkouts WHERE physical_worktree_hash = ? AND unlinked_at IS NULL", record.Summary.PhysicalWorktreeHash).Scan(&existing)
	if err == nil {
		return Record{}, failure("checkout_already_linked")
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Record{}, failure("storage_failed")
	}
	if input.IsDefault {
		err = tx.QueryRowContext(ctx, "SELECT id FROM checkouts WHERE workspace_id = ? AND runner_id = ? AND project_id = ? AND is_default = 1 AND unlinked_at IS NULL", input.WorkspaceID, input.RunnerID, input.ProjectID).Scan(&existing)
		if err == nil {
			return Record{}, failure("checkout_default_conflict")
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return Record{}, failure("storage_failed")
		}
	}
	values := record.values()
	query := "INSERT INTO checkouts (" + recordColumns + ") VALUES (" + strings.TrimSuffix(strings.Repeat("?,", len(values)), ",") + ")"
	if _, err = tx.ExecContext(ctx, query, values...); err != nil {
		return Record{}, failure("storage_failed")
	}
	if tx.Commit() != nil {
		return Record{}, failure("storage_failed")
	}
	return record, nil
}

func (record *Record) observe(observed Observation) {
	record.Config = observed.Config
	record.Summary.RepositoryConfigHash = observed.Config.Hash
	record.Summary.Branch = optionalText(observed.Branch)
	record.Summary.Head = optionalText(observed.Head)
	record.Summary.Dirty = observed.Dirty
	record.Summary.ValidatedAt = observed.ValidatedAt
	record.Summary.Status, record.Summary.BlockReason = "validated", nil
}

func (record Record) values() []any {
	s, location := record.Summary, record.Location
	return []any{
		s.CheckoutId, s.WorkspaceId, s.RunnerId, s.ProjectId, s.Label, s.IsDefault,
		location.RegisteredPath, location.WorkingDirectory, location.GitRoot, location.GitDirectory, location.GitCommonDirectory,
		location.WorkspaceSubpath, location.CwdIdentity, location.RootIdentity, location.GitIdentity, location.CommonIdentity,
		record.RemoteName, s.RepositoryIdentity, s.PhysicalWorktreeHash, textValue(s.Branch), textValue(s.Head), s.Dirty,
		record.Config.Canonical, s.RepositoryConfigHash, s.Status, textValue(s.BlockReason), s.ValidatedAt,
	}
}

type rowScanner interface{ Scan(...any) error }

func scanRecord(row rowScanner) (Record, error) {
	var record Record
	s, location := &record.Summary, &record.Location
	var branch, head, reason, canonical string
	err := row.Scan(
		&s.CheckoutId, &s.WorkspaceId, &s.RunnerId, &s.ProjectId, &s.Label, &s.IsDefault,
		&location.RegisteredPath, &location.WorkingDirectory, &location.GitRoot, &location.GitDirectory, &location.GitCommonDirectory,
		&location.WorkspaceSubpath, &location.CwdIdentity, &location.RootIdentity, &location.GitIdentity, &location.CommonIdentity,
		&record.RemoteName, &s.RepositoryIdentity, &s.PhysicalWorktreeHash, &branch, &head, &s.Dirty,
		&canonical, &s.RepositoryConfigHash, &s.Status, &reason, &s.ValidatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Record{}, failure("checkout_not_found")
	}
	if err != nil {
		return Record{}, failure("storage_failed")
	}
	record.Config, err = ParseRepositoryConfig([]byte(canonical))
	if err != nil || record.Config.Canonical != canonical || record.Config.Hash != s.RepositoryConfigHash {
		return Record{}, failure("storage_failed")
	}
	s.SchemaVersion, s.WorkspaceSubpath = 1, location.WorkspaceSubpath
	s.Branch, s.Head, s.BlockReason = optionalText(branch), optionalText(head), optionalText(reason)
	location.PhysicalWorktreeHash = s.PhysicalWorktreeHash
	if !validSummary(*s) || !remoteNamePattern.MatchString(record.RemoteName) || physicalWorktreeHash(location.RootIdentity) != s.PhysicalWorktreeHash {
		return Record{}, failure("storage_failed")
	}
	return record, nil
}

func (registry *Registry) Get(ctx context.Context, id string) (Record, error) {
	if !idPattern.MatchString(id) {
		return Record{}, failure("invalid_request")
	}
	return scanRecord(registry.db.QueryRowContext(ctx, "SELECT "+recordColumns+" FROM checkouts WHERE id = ? AND unlinked_at IS NULL", id))
}

func revalidate(ctx context.Context, record Record) (Observation, error) {
	observed, err := Observe(ctx, record.Location.RegisteredPath, record.RemoteName)
	if err != nil {
		return Observation{}, err
	}
	if observed.Location != record.Location {
		return Observation{}, failure("checkout_identity_changed")
	}
	if observed.RepositoryIdentity != record.Summary.RepositoryIdentity {
		return Observation{}, failure("checkout_repository_mismatch")
	}
	if observed.Config.Hash != record.Config.Hash {
		return observed, failure("checkout_config_changed")
	}
	return observed, nil
}

// Revalidate reads the actual checkout and does not refresh or repair its registration.
func (registry *Registry) Revalidate(ctx context.Context, id string) (Observation, error) {
	record, err := registry.Get(ctx, id)
	if err != nil {
		return Observation{}, err
	}
	return revalidate(ctx, record)
}

// RevalidateForExecution cannot reuse an old claimed config hash after a routine Verify refresh.
func (registry *Registry) RevalidateForExecution(ctx context.Context, id, expectedConfigHash string, parent Policy) (Observation, error) {
	observed, err := registry.Revalidate(ctx, id)
	if err != nil {
		return observed, err
	}
	_, err = observed.Config.CheckExecution(expectedConfigHash, parent)
	return observed, err
}

func (registry *Registry) Verify(ctx context.Context, id string) (Record, error) {
	record, err := registry.Get(ctx, id)
	if err != nil {
		return Record{}, err
	}
	observed, validationErr := revalidate(ctx, record)
	code := ""
	if validationErr != nil {
		code = daemon.AsFailure(validationErr).Code
	}
	if validationErr == nil || code == "checkout_config_changed" {
		record.observe(observed)
		if code != "" {
			record.Summary.Status, record.Summary.BlockReason = "stale", optionalText(code)
		}
	} else {
		record.Summary.Status, record.Summary.BlockReason = "blocked", optionalText(code)
	}
	if !validSummary(record.Summary) {
		return Record{}, failure("storage_failed")
	}
	result, err := registry.db.ExecContext(ctx, `UPDATE checkouts SET branch = ?, head = ?, dirty = ?,
canonical_config = ?, repository_config_hash = ?, status = ?, block_reason = ?, validated_at = ?
WHERE id = ? AND unlinked_at IS NULL`,
		textValue(record.Summary.Branch), textValue(record.Summary.Head), record.Summary.Dirty,
		record.Config.Canonical, record.Summary.RepositoryConfigHash, record.Summary.Status,
		textValue(record.Summary.BlockReason), record.Summary.ValidatedAt, id)
	if err != nil {
		return Record{}, failure("storage_failed")
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		return Record{}, failure("checkout_not_found")
	}
	return record, validationErr
}

func (registry *Registry) List(ctx context.Context, options ListOptions) ([]generated.CheckoutSummary, string, error) {
	if options.Limit == 0 {
		options.Limit = 25
	}
	if options.Limit < 1 || options.Limit > 25 {
		return nil, "", failure("invalid_request")
	}
	query, values := "SELECT "+recordColumns+" FROM checkouts WHERE unlinked_at IS NULL", []any{}
	for _, filter := range []struct{ column, value string }{
		{"workspace_id", options.WorkspaceID}, {"runner_id", options.RunnerID}, {"project_id", options.ProjectID},
	} {
		if filter.value != "" {
			if !idPattern.MatchString(filter.value) {
				return nil, "", failure("invalid_request")
			}
			query += " AND " + filter.column + " = ?"
			values = append(values, filter.value)
		}
	}
	if options.After != "" {
		if !idPattern.MatchString(options.After) {
			return nil, "", failure("invalid_request")
		}
		query += " AND id > ?"
		values = append(values, options.After)
	}
	query += " ORDER BY id LIMIT ?"
	values = append(values, options.Limit+1)
	rows, err := registry.db.QueryContext(ctx, query, values...)
	if err != nil {
		return nil, "", failure("storage_failed")
	}
	defer func() { _ = rows.Close() }()
	summaries := []generated.CheckoutSummary{}
	next := ""
	for rows.Next() {
		record, err := scanRecord(rows)
		if err != nil {
			return nil, "", err
		}
		if len(summaries) == options.Limit {
			next = summaries[len(summaries)-1].CheckoutId
			break
		}
		validatedAt, _ := time.Parse(time.RFC3339Nano, record.Summary.ValidatedAt)
		if record.Summary.Status == "validated" && time.Since(validatedAt) > time.Minute {
			record.Summary.Status = "stale"
		}
		summaries = append(summaries, record.Summary)
	}
	if rows.Err() != nil {
		return nil, "", failure("storage_failed")
	}
	return summaries, next, nil
}

func (registry *Registry) Unlink(ctx context.Context, id string) error {
	if !idPattern.MatchString(id) {
		return failure("invalid_request")
	}
	now := time.Now().UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano)
	result, err := registry.db.ExecContext(ctx, "UPDATE checkouts SET unlinked_at = ? WHERE id = ? AND unlinked_at IS NULL", now, id)
	if err != nil {
		return failure("storage_failed")
	}
	if affected, err := result.RowsAffected(); err == nil && affected == 1 {
		return nil
	}
	var exists int
	if err = registry.db.QueryRowContext(ctx, "SELECT 1 FROM checkouts WHERE id = ?", id).Scan(&exists); err == nil {
		return nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return failure("checkout_not_found")
	}
	return failure("storage_failed")
}

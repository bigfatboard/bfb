// ABOUTME: Persists non-secret enrollment identity and deduplicated durable delivery references.
// ABOUTME: Recovers interrupted key creation without rotating identity and acknowledges only durable consumer acceptance.

package runner

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/qdis/bfb/internal/auth"
	"github.com/qdis/bfb/internal/daemon"
)

type Store struct{ db *sql.DB }

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

func (store *Store) Recover(ctx context.Context) error {
	_, err := store.db.ExecContext(ctx, `UPDATE runner_enrollments SET connection_state = 'offline' WHERE connection_state IN ('online', 'connecting')`)
	return err
}

func scanEnrollment(row interface{ Scan(...any) error }) (Enrollment, error) {
	var enrollment Enrollment
	var public, thumb sql.NullString
	err := row.Scan(&enrollment.RunnerID, &enrollment.WorkspaceID, &enrollment.Origin, &enrollment.Label, &public, &thumb, &enrollment.State, &enrollment.TokenEpoch, &enrollment.CreatedAt)
	enrollment.PublicKey = json.RawMessage(public.String)
	enrollment.Thumbprint = thumb.String
	return enrollment, err
}

const enrollmentColumns = `id, workspace_id, app_origin, device_label, public_key_json, key_thumbprint, connection_state, token_epoch, created_at`

func (store *Store) Get(ctx context.Context, runner string) (Enrollment, error) {
	return scanEnrollment(store.db.QueryRowContext(ctx, `SELECT `+enrollmentColumns+` FROM runner_enrollments WHERE id = ?`, runner))
}

func (store *Store) List(ctx context.Context) ([]Enrollment, error) {
	rows, err := store.db.QueryContext(ctx, `SELECT `+enrollmentColumns+` FROM runner_enrollments ORDER BY id LIMIT 17`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Enrollment{}
	for rows.Next() {
		enrollment, err := scanEnrollment(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, enrollment)
	}
	if len(result) > 16 {
		return nil, ErrProtocol
	}
	return result, rows.Err()
}

func (store *Store) Begin(ctx context.Context, origin, workspace, label string) (Enrollment, error) {
	if _, err := canonicalOrigin(origin); err != nil || !ulidPattern.MatchString(workspace) || !labelPattern.MatchString(label) || strings.TrimSpace(label) != label {
		return Enrollment{}, ErrProtocol
	}
	previous, err := scanEnrollment(store.db.QueryRowContext(ctx, `SELECT `+enrollmentColumns+` FROM runner_enrollments WHERE app_origin = ? AND workspace_id = ?`, origin, workspace))
	if err == nil {
		if previous.State == "revoked" {
			return Enrollment{}, ErrRevoked
		}
		if previous.Label != label {
			return Enrollment{}, ErrProtocol
		}
		return previous, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Enrollment{}, err
	}
	enrollment := Enrollment{RunnerID: daemon.NewRequestID(), WorkspaceID: workspace, Origin: origin, Label: label, State: "key_pending", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	result, err := store.db.ExecContext(ctx, `INSERT INTO runner_enrollments (id,workspace_id,app_origin,device_label,connection_state,created_at) SELECT ?,?,?,?,'key_pending',? WHERE (SELECT COUNT(*) FROM runner_enrollments) < 16`, enrollment.RunnerID, workspace, origin, label, enrollment.CreatedAt)
	if err != nil {
		return Enrollment{}, err
	}
	if count, _ := result.RowsAffected(); count != 1 {
		return Enrollment{}, ErrProtocol
	}
	return enrollment, nil
}

func (store *Store) CompleteKey(ctx context.Context, enrollment Enrollment, credentials Credentials) (Enrollment, error) {
	if len(enrollment.PublicKey) != 0 {
		if enrollment.validate() != nil {
			return Enrollment{}, ErrProtocol
		}
		return enrollment, nil
	}
	ref := auth.CredentialRef{Kind: auth.RunnerKey, WorkspaceID: enrollment.WorkspaceID, ID: enrollment.RunnerID}
	public, err := credentials.PublicKey(ctx, ref)
	if errors.Is(err, auth.ErrCredentialNotFound) {
		public, err = credentials.CreateKey(ctx, ref)
	}
	if err != nil {
		return Enrollment{}, err
	}
	// Native creation and lookup always return canonical exact public JWK fields.
	digest := sha256.Sum256(public)
	enrollment.PublicKey = public
	enrollment.Thumbprint = "sha256:" + hex.EncodeToString(digest[:])
	enrollment.State = "pending_approval"
	if enrollment.validate() != nil {
		return Enrollment{}, ErrProtocol
	}
	result, err := store.db.ExecContext(ctx, `UPDATE runner_enrollments SET public_key_json = ?, key_thumbprint = ?, connection_state = 'pending_approval' WHERE id = ? AND public_key_json IS NULL AND connection_state != 'revoked'`, string(public), enrollment.Thumbprint, enrollment.RunnerID)
	if err != nil {
		return Enrollment{}, err
	}
	if count, _ := result.RowsAffected(); count != 1 {
		return Enrollment{}, ErrProtocol
	}
	return enrollment, nil
}

func (store *Store) SetState(ctx context.Context, runner, state string) error {
	if !validState(state) {
		return ErrProtocol
	}
	result, err := store.db.ExecContext(ctx, `UPDATE runner_enrollments SET connection_state = ? WHERE id = ? AND (connection_state != 'revoked' OR ? = 'revoked')`, state, runner, state)
	if err != nil {
		return err
	}
	if count, _ := result.RowsAffected(); count != 1 {
		return ErrRevoked
	}
	return nil
}

func validState(state string) bool {
	switch state {
	case "key_pending", "pending_approval", "connecting", "online", "offline", "credential_unavailable", "authorization_required", "sync_blocked", "revoked":
		return true
	}
	return false
}

func (store *Store) SaveEpoch(ctx context.Context, runner string, epoch int64) error {
	result, err := store.db.ExecContext(ctx, `UPDATE runner_enrollments SET token_epoch = ? WHERE id = ? AND token_epoch < ? AND connection_state != 'revoked'`, epoch, runner, epoch)
	if err != nil {
		return err
	}
	if count, _ := result.RowsAffected(); count != 1 {
		return ErrAuthorization
	}
	return nil
}

func (store *Store) NextInventoryRevision(ctx context.Context, runner string) (int64, error) {
	var revision int64
	err := store.db.QueryRowContext(ctx, `UPDATE runner_enrollments SET inventory_revision = inventory_revision + 1 WHERE id = ? AND connection_state != 'revoked' RETURNING inventory_revision`, runner).Scan(&revision)
	return revision, err
}

func EnrollmentURL(enrollment Enrollment) (string, error) {
	if enrollment.validate() != nil {
		return "", ErrProtocol
	}
	public, _ := json.Marshal(map[string]any{"schema_version": 1, "workspace_id": enrollment.WorkspaceID, "runner_id": enrollment.RunnerID, "device_label": enrollment.Label, "public_key": enrollment.PublicKey})
	return enrollment.Origin + "/runner-enroll#" + base64.RawURLEncoding.EncodeToString(public), nil
}

type CommandReference struct {
	ID        string `json:"command_id"`
	Kind      string `json:"command_kind"`
	ExpiresAt string `json:"expires_at"`
}

// Accept must be idempotent by runner/command ID and return only after its own
// durable state commits. A crash after Accept may replay the same reference.
type CommandConsumer func(context.Context, Enrollment, CommandReference) error

func (store *Store) Receive(ctx context.Context, runner string, commands []CommandReference) error {
	if len(commands) > 25 {
		return ErrProtocol
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, command := range commands {
		if !ulidPattern.MatchString(command.ID) || (command.Kind != "launch" && command.Kind != "run_control" && command.Kind != "discussion_turn") {
			return ErrProtocol
		}
		if _, err = time.Parse(time.RFC3339Nano, command.ExpiresAt); err != nil {
			return ErrProtocol
		}
		var previousKind, previousExpiry string
		err = tx.QueryRowContext(ctx, `SELECT command_kind, expires_at FROM runner_command_inbox WHERE runner_id = ? AND command_id = ?`, runner, command.ID).Scan(&previousKind, &previousExpiry)
		if err == nil {
			if previousKind != command.Kind || previousExpiry != command.ExpiresAt {
				return ErrProtocol
			}
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		result, err := tx.ExecContext(ctx, `INSERT INTO runner_command_inbox (runner_id,command_id,command_kind,expires_at,received_at) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM runner_command_inbox WHERE runner_id = ? AND accepted_at IS NULL) < 256 AND (SELECT COUNT(*) FROM runner_command_inbox WHERE runner_id = ?) < 4096`, runner, command.ID, command.Kind, command.ExpiresAt, time.Now().UTC().Format(time.RFC3339Nano), runner, runner)
		if err != nil {
			return err
		}
		if count, _ := result.RowsAffected(); count != 1 {
			return ErrProtocol
		}
	}
	return tx.Commit()
}

func (store *Store) Deliver(ctx context.Context, enrollment Enrollment, consumers map[string]CommandConsumer) error {
	current, err := store.Get(ctx, enrollment.RunnerID)
	if err != nil {
		return err
	}
	if current.State == "revoked" {
		return ErrRevoked
	}
	rows, err := store.db.QueryContext(ctx, `SELECT command_id, command_kind, expires_at FROM runner_command_inbox WHERE runner_id = ? AND accepted_at IS NULL ORDER BY command_id LIMIT 256`, enrollment.RunnerID)
	if err != nil {
		return err
	}
	commands := []CommandReference{}
	for rows.Next() {
		var command CommandReference
		if err = rows.Scan(&command.ID, &command.Kind, &command.ExpiresAt); err != nil {
			rows.Close()
			return err
		}
		commands = append(commands, command)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, command := range commands {
		consumer := consumers[command.Kind]
		if consumer == nil {
			continue
		}
		if err = consumer(ctx, enrollment, command); err != nil {
			return err
		}
		if _, err = store.db.ExecContext(ctx, `UPDATE runner_command_inbox SET accepted_at = ? WHERE runner_id = ? AND command_id = ? AND accepted_at IS NULL`, time.Now().UTC().Format(time.RFC3339Nano), enrollment.RunnerID, command.ID); err != nil {
			return err
		}
	}
	return nil
}

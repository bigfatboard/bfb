// ABOUTME: Validates explicit run result submissions with bounded generic evidence references.
// ABOUTME: Shares the results.md bounds; config identity and time are bound server-side, never by the caller.

package localmcp

import (
	"context"
	"crypto/subtle"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	maxSummaryLen     = 2048
	maxLimitationsLen = 2048
	maxBranchLen      = 256
	maxEvidenceRefs   = 20
	maxEvidenceKind   = 64
	maxEvidenceRef    = 512
	maxEvidenceVer    = 128
)

// EvidenceRef is one generic evidence reference from results.md. A03 stores
// these opaquely; V01 validates artifact_version referents and extends the
// outdated rule without changing this shape.
type EvidenceRef struct {
	Kind    string `json:"kind"`
	Ref     string `json:"ref"`
	Version string `json:"version,omitempty"`
	Hash    string `json:"hash,omitempty"`
}

// SubmitResultInput is the validated agent submission. Config snapshot, run
// version, and timestamp are bound by the hub command, never the caller.
type SubmitResultInput struct {
	Summary     string
	Limitations string
	Evidence    []EvidenceRef
	GitBranch   *string
	GitCommit   *string
	GitDirty    *bool
}

// SubmitResultResult is the committed idempotent outcome of a submission.
type SubmitResultResult struct {
	SubmissionID string `json:"submission_id"`
	Version      int64  `json:"version"`
	ResultState  string `json:"result_state"`
}

func validEvidenceKind(value string) bool {
	runes := []rune(value)
	if len(runes) == 0 || len(runes) > maxEvidenceKind {
		return false
	}
	for index, character := range runes {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' {
			if index == 0 {
				continue
			}
			continue
		}
		if index == 0 {
			return false
		}
		if character != '-' && character != '_' {
			return false
		}
	}
	return true
}

func validHex(value string, length int) bool {
	if len(value) != length {
		return false
	}
	for _, character := range value {
		if character >= '0' && character <= '9' || character >= 'a' && character <= 'f' {
			continue
		}
		return false
	}
	return true
}

func validEvidenceHash(value string) bool {
	if !strings.HasPrefix(value, "sha256:") {
		return false
	}
	return validHex(strings.TrimPrefix(value, "sha256:"), 64)
}

// ValidateSubmitInput validates one bfb_submit_result argument map and
// returns the input plus its canonical journal payload. Unknown fields are
// rejected so workflow, routing, or identity fields cannot be smuggled.
func ValidateSubmitInput(params map[string]any) (SubmitResultInput, map[string]any, error) {
	var input SubmitResultInput
	rawSummary, present := params["summary"]
	if !present {
		return SubmitResultInput{}, nil, fail("invalid_params")
	}
	summary, ok := rawSummary.(string)
	if !ok {
		return SubmitResultInput{}, nil, fail("invalid_params")
	}
	normalized, err := boundedText(summary, "summary", maxSummaryLen)
	if err != nil {
		return SubmitResultInput{}, nil, fail("invalid_params")
	}
	input.Summary = normalized
	canonical := map[string]any{"summary": normalized}
	if raw, present := params["limitations"]; present {
		text, ok := raw.(string)
		if !ok {
			return SubmitResultInput{}, nil, fail("invalid_params")
		}
		trimmed := strings.TrimSpace(text)
		if trimmed != "" {
			limitations, err := boundedText(text, "limitations", maxLimitationsLen)
			if err != nil {
				return SubmitResultInput{}, nil, fail("invalid_params")
			}
			input.Limitations = limitations
			canonical["limitations"] = limitations
		}
	}
	if raw, present := params["evidence_refs"]; present {
		refs, encoded, err := validateEvidenceRefs(raw)
		if err != nil {
			return SubmitResultInput{}, nil, err
		}
		input.Evidence = refs
		canonical["evidence_refs"] = encoded
	}
	if raw, present := params["git_branch"]; present {
		text, ok := raw.(string)
		if !ok {
			return SubmitResultInput{}, nil, fail("invalid_params")
		}
		branch, err := boundedText(text, "git_branch", maxBranchLen)
		if err != nil {
			return SubmitResultInput{}, nil, fail("invalid_params")
		}
		input.GitBranch = &branch
		canonical["git_branch"] = branch
	}
	if raw, present := params["git_commit"]; present {
		text, ok := raw.(string)
		if !ok || !validHex(text, 40) {
			return SubmitResultInput{}, nil, fail("invalid_params")
		}
		input.GitCommit = &text
		canonical["git_commit"] = text
	}
	if raw, present := params["git_dirty"]; present {
		dirty, ok := raw.(bool)
		if !ok {
			return SubmitResultInput{}, nil, fail("invalid_params")
		}
		input.GitDirty = &dirty
		canonical["git_dirty"] = dirty
	}
	return input, canonical, nil
}

func validateEvidenceRefs(raw any) ([]EvidenceRef, []any, error) {
	list, ok := raw.([]any)
	if !ok || len(list) > maxEvidenceRefs {
		return nil, nil, fail("invalid_params")
	}
	refs := make([]EvidenceRef, 0, len(list))
	encoded := make([]any, 0, len(list))
	seen := make(map[string]bool)
	for _, entry := range list {
		record, ok := entry.(map[string]any)
		if !ok {
			return nil, nil, fail("invalid_params")
		}
		for key := range record {
			if key != "kind" && key != "ref" && key != "version" && key != "hash" {
				return nil, nil, fail("invalid_params")
			}
		}
		kind, ok := record["kind"].(string)
		if !ok || !validEvidenceKind(strings.TrimSpace(kind)) {
			return nil, nil, fail("invalid_params")
		}
		kind = strings.TrimSpace(kind)
		ref, ok := record["ref"].(string)
		if !ok {
			return nil, nil, fail("invalid_params")
		}
		normalized, err := boundedText(ref, "ref", maxEvidenceRef)
		if err != nil {
			return nil, nil, fail("invalid_params")
		}
		var version string
		if rawVersion, present := record["version"]; present {
			text, ok := rawVersion.(string)
			if !ok {
				return nil, nil, fail("invalid_params")
			}
			checked, err := boundedText(text, "version", maxEvidenceVer)
			if err != nil {
				return nil, nil, fail("invalid_params")
			}
			version = checked
		}
		var hash string
		if rawHash, present := record["hash"]; present {
			text, ok := rawHash.(string)
			if !ok || !validEvidenceHash(text) {
				return nil, nil, fail("invalid_params")
			}
			hash = text
		}
		identity := kind + "\n" + normalized + "\n" + version
		if seen[identity] {
			return nil, nil, fail("invalid_params")
		}
		seen[identity] = true
		refs = append(refs, EvidenceRef{Kind: kind, Ref: normalized, Version: version, Hash: hash})
		item := map[string]any{"kind": kind, "ref": normalized}
		if version != "" {
			item["version"] = version
		}
		if hash != "" {
			item["hash"] = hash
		}
		encoded = append(encoded, item)
	}
	return refs, encoded, nil
}

// restoreSubmit rebuilds a journaled submission for replay with its original
// request_id so transport-side idempotency returns the first outcome.
func restoreSubmit(input map[string]any) (SubmitResultInput, error) {
	rebuilt := map[string]any{}
	for key, value := range input {
		rebuilt[key] = value
	}
	params, _, err := ValidateSubmitInput(rebuilt)
	if err != nil {
		return SubmitResultInput{}, err
	}
	return params, nil
}

// CLISubmission carries a validated one-shot CLI submission for journaling.
// The CLI has no observed provider session, so SessionID stays empty; replay
// treats the row identically to an MCP-journaled submission otherwise.
type CLISubmission struct {
	Env         ScopedEnv
	Assignments AssignmentSource
	Journal     Journal
	Policy      OfflinePolicy
	Canonical   map[string]any
	RequestID   string
	Now         time.Time
}

// JournalCLIResult verifies the active assignment and correlation for a
// one-shot CLI submission, then journals it durably keyed by request_id.
// Process-group membership is not required: the correlation capability is
// the same-execution secret, and the one-shot caller cannot hold a session
// binding. Repeats return the original receipt or the stored outcome.
func JournalCLIResult(ctx context.Context, sub CLISubmission) (any, error) {
	if err := checkRequestID(sub.RequestID); err != nil {
		return nil, err
	}
	record, err := sub.Assignments.Lookup(ctx, sub.Env.ExecutionID, sub.Env.Generation)
	if err != nil {
		return nil, err
	}
	if record.Boundary.ExecutionID != sub.Env.ExecutionID ||
		record.Boundary.Generation != sub.Env.Generation ||
		record.Boundary.RunID != sub.Env.RunID ||
		record.Boundary.TaskID != sub.Env.TaskID ||
		record.Boundary.ProjectID != sub.Env.ProjectID ||
		record.Boundary.WorkspaceID != sub.Env.WorkspaceID {
		return nil, fail("assignment_unknown")
	}
	if !record.Active {
		return nil, fail("assignment_ended")
	}
	if len(sub.Env.Correlation) == 0 ||
		subtle.ConstantTimeCompare([]byte(sub.Env.Correlation), []byte(record.CorrelationToken)) != 1 {
		return nil, fail("correlation_rejected")
	}
	policy := sub.Policy
	if policy == nil {
		policy = DefaultOfflinePolicy{AllowPending: true}
	}
	if policy.Decide("bfb_submit_result") != OfflinePending {
		return nil, fail("offline_rejected")
	}
	now := sub.Now
	if now.IsZero() {
		now = time.Now()
	}
	now = now.UTC().Truncate(time.Microsecond)
	operation := PendingOperation{
		RequestID:      sub.RequestID,
		Tool:           "bfb_submit_result",
		Boundary:       record.Boundary,
		Principal:      "agent_run:" + record.Boundary.RunID,
		Grant:          "runner:" + record.Boundary.RunnerID,
		CapturedAt:     now.Format(time.RFC3339Nano),
		ExpiresAt:      now.Add(pendingTTLHours * time.Hour).Format(time.RFC3339Nano),
		PolicyDecision: string(OfflinePending),
	}
	return stagePending(sub.Journal, sub.Canonical, operation)
}

// nonEmptyText reports whether a value is a non-blank UTF-8 string without
// control characters. It backs CLI flag validation, which shares these bounds.
func nonEmptyText(value string, maximum int) bool {
	normalized := strings.TrimSpace(value)
	if normalized == "" || len([]rune(normalized)) > maximum || !utf8.ValidString(value) {
		return false
	}
	for _, character := range normalized {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

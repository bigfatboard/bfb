// ABOUTME: Validates bounded participant recommendations and assembles conclusions without invention.
// ABOUTME: Disagreements are preserved verbatim; a conclusion references outputs, never synthesizes consensus.

package discussion

import (
	"context"
	"encoding/json"
	"strings"
)

// MaxOutputBytes bounds one typed participant output, matching the D01 brief.
const MaxOutputBytes = 8192

// EvidenceRef attributes one supporting reference to frozen context or to a
// repository-relative file at the frozen Git revision.
type EvidenceRef struct {
	Kind           string `json:"kind"`
	ContextID      string `json:"context_id,omitempty"`
	RepositoryPath string `json:"repository_path,omitempty"`
	GitRevision    string `json:"git_revision,omitempty"`
}

// MessageRef attributes one agreement or disagreement to a completed source message.
type MessageRef struct {
	MessageID string `json:"message_id"`
	Note      string `json:"note,omitempty"`
}

// Recommendation is the bounded typed output of one participant turn.
type Recommendation struct {
	SchemaVersion  int           `json:"schema_version"`
	Recommendation string        `json:"recommendation"`
	Reasons        []string      `json:"reasons"`
	Evidence       []EvidenceRef `json:"evidence"`
	Agreement      []MessageRef  `json:"agreement"`
	Disagreements  []MessageRef  `json:"disagreements"`
	HumanQuestions []string      `json:"human_questions"`
}

func validMessageID(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for _, char := range value {
		if char < 32 || char == 127 {
			return false
		}
	}
	return true
}

func validRelativePath(value string) bool {
	if value == "" || len(value) > 512 || strings.HasPrefix(value, "/") {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

// ValidateRecommendation decodes one strict bounded output. Unknown fields,
// oversized bodies, unresolvable evidence, and references outside the frozen
// causal source set fail visibly instead of entering the record.
func ValidateRecommendation(raw []byte, sources []string, contextIDs map[string]bool, revision string) (Recommendation, error) {
	var output Recommendation
	if len(raw) == 0 || len(raw) > MaxOutputBytes {
		return Recommendation{}, failure("output_bound_exceeded")
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&output); err != nil {
		return Recommendation{}, failure("output_malformed")
	}
	if output.SchemaVersion != 1 || output.Recommendation == "" || len(output.Recommendation) > MaxOutputBytes {
		return Recommendation{}, failure("output_malformed")
	}
	if len(output.Reasons) > 8 || len(output.Evidence) > 8 || len(output.HumanQuestions) > 4 {
		return Recommendation{}, failure("output_bound_exceeded")
	}
	for _, reason := range output.Reasons {
		if reason == "" || len(reason) > 1024 {
			return Recommendation{}, failure("output_malformed")
		}
	}
	for _, question := range output.HumanQuestions {
		if question == "" || len(question) > 1024 {
			return Recommendation{}, failure("output_malformed")
		}
	}
	available := map[string]bool{}
	for _, id := range sources {
		available[id] = true
	}
	for _, evidence := range output.Evidence {
		switch evidence.Kind {
		case "context":
			if !contextIDs[evidence.ContextID] {
				return Recommendation{}, failure("output_forbidden")
			}
		case "file":
			if evidence.GitRevision != revision || !validRelativePath(evidence.RepositoryPath) {
				return Recommendation{}, failure("output_forbidden")
			}
		default:
			return Recommendation{}, failure("output_malformed")
		}
	}
	for _, reference := range append(append([]MessageRef{}, output.Agreement...), output.Disagreements...) {
		if !validMessageID(reference.MessageID) || !available[reference.MessageID] || len(reference.Note) > 1024 {
			return Recommendation{}, failure("output_forbidden")
		}
	}
	return output, nil
}

// StoreOutput persists one validated output for a completed turn.
func (store *Store) StoreOutput(ctx context.Context, discussionID string, slot, ordinal int, attemptID string, validated Recommendation, now string) error {
	encoded, err := json.Marshal(validated)
	if err != nil || len(encoded) > MaxOutputBytes {
		return failure("output_bound_exceeded")
	}
	if _, err := store.db.ExecContext(ctx,
		`INSERT INTO discussion_outputs (discussion_id, slot, ordinal, attempt_id, output_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		discussionID, slot, ordinal, attemptID, string(encoded), now); err != nil {
		return failure("storage_failed")
	}
	return nil
}

// ReadOutput loads the validated output of one completed turn.
func (store *Store) ReadOutput(ctx context.Context, discussionID string, slot, ordinal int) (Recommendation, error) {
	var encoded string
	if err := store.db.QueryRowContext(ctx,
		`SELECT output_json FROM discussion_outputs WHERE discussion_id = ? AND slot = ? AND ordinal = ?`,
		discussionID, slot, ordinal).Scan(&encoded); err != nil {
		return Recommendation{}, failure("output_required")
	}
	var output Recommendation
	decoder := json.NewDecoder(strings.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&output); err != nil {
		return Recommendation{}, failure("storage_failed")
	}
	return output, nil
}

// Conclusion freezes references to the final two attributed recommendations.
// It preserves disagreements verbatim and never synthesizes consensus.
type Conclusion struct {
	DiscussionID     string            `json:"discussion_id"`
	Recommendations  [2]Recommendation `json:"recommendations"`
	DisagreementKept bool              `json:"disagreement_kept"`
}

// AssembleConclusion builds the bounded conclusion from the final two
// completed turns of a finished schedule. Every scheduled turn must have a
// stored output; a missing or extra turn fails instead of concluding.
func (store *Store) AssembleConclusion(ctx context.Context, discussionID string) (Conclusion, error) {
	schedule, err := store.ReadSchedule(ctx, discussionID)
	if err != nil {
		return Conclusion{}, err
	}
	total := schedule.Rounds * 2
	if len(schedule.Completed) != total {
		return Conclusion{}, failure("conclusion_blocked")
	}
	var conclusion Conclusion
	conclusion.DiscussionID = discussionID
	for index, ordinal := range []int{total - 1, total} {
		output, err := store.ReadOutput(ctx, discussionID, slotForOrdinal(ordinal), ordinal)
		if err != nil {
			return Conclusion{}, err
		}
		conclusion.Recommendations[index] = output
	}
	for _, output := range conclusion.Recommendations {
		if len(output.Disagreements) != 0 {
			conclusion.DisagreementKept = true
		}
	}
	return conclusion, nil
}

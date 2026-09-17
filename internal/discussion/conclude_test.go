// ABOUTME: Proves bounded conclusions reference the final two outputs and keep disagreements.
// ABOUTME: An unfinished schedule cannot conclude, and a conclusion never invents consensus.

package discussion_test

import (
	"context"
	"testing"

	"github.com/qdis/bfb/internal/discussion"
)

func runFullDiscussion(t *testing.T, fixture *discussionFixture, sessions [2]string) {
	t.Helper()
	ctx := context.Background()
	ordinals := []struct {
		slot, ordinal, key int
		fresh              bool
	}{
		{0, 1, 1, true},
		{1, 2, 2, true},
		{0, 3, 3, false},
		{1, 4, 4, false},
		{0, 5, 5, false},
		{1, 6, 6, false},
	}
	for _, turn := range ordinals {
		session := ""
		if !turn.fresh {
			session = sessions[turn.slot]
		} else {
			sessions[turn.slot] = "synthetic-session-" + string(rune('a'+turn.slot))
		}
		fixture.runner.byOrdinal[turn.ordinal] = scriptedTurn{
			session: sessions[turn.slot],
			output:  validOutput("position"),
		}
		request := fixture.request(turn.slot, turn.ordinal, turn.key, turn.fresh, session)
		if err := discussion.DispatchTurn(ctx, fixture.store, fixture.planner, fixture.authority, fixture.runner, request, nil, map[string]bool{}, "sha256:"+"c", nowAt(10+turn.ordinal)); err != nil {
			t.Fatalf("ordinal %d: %v", turn.ordinal, err)
		}
	}
}

func TestFullDiscussionConcludesWithBothFinalPositions(t *testing.T) {
	ctx := context.Background()
	fixture := setupDiscussion(t, 3)
	runFullDiscussion(t, fixture, [2]string{})
	conclusion, err := fixture.store.AssembleConclusion(ctx, fixture.discussion)
	if err != nil {
		t.Fatal(err)
	}
	if conclusion.DiscussionID != fixture.discussion {
		t.Fatal("conclusion must name its discussion")
	}
	for _, output := range conclusion.Recommendations {
		if output.Recommendation != "position" || output.SchemaVersion != 1 {
			t.Fatalf("conclusion must reference stored outputs verbatim, got %+v", output)
		}
	}
	// Six turns ran exactly once each: no duplicate provider effects.
	if len(fixture.runner.calls) != 6 {
		t.Fatalf("six turns need six effects, got %d", len(fixture.runner.calls))
	}
}

func TestConclusionPreservesDisagreement(t *testing.T) {
	ctx := context.Background()
	fixture := setupDiscussion(t, 1)
	disputed := `{"schema_version":1,"recommendation":"ship option A","reasons":["faster"],"evidence":[],"agreement":[],"disagreements":[{"message_id":"m1","note":"option B is safer"}],"human_questions":[]}`
	second := `{"schema_version":1,"recommendation":"ship option B","reasons":["safer"],"evidence":[],"agreement":[],"disagreements":[{"message_id":"m1","note":"option A is faster"}],"human_questions":[]}`
	fixture.runner.byOrdinal[1] = scriptedTurn{session: "synthetic-session-a", output: []byte(disputed)}
	fixture.runner.byOrdinal[2] = scriptedTurn{session: "synthetic-session-b", output: []byte(second)}
	if err := discussion.DispatchTurn(ctx, fixture.store, fixture.planner, fixture.authority, fixture.runner, fixture.request(0, 1, 1, true, ""), []string{"m1"}, map[string]bool{}, "sha256:"+"c", nowAt(11)); err != nil {
		t.Fatal(err)
	}
	if err := discussion.DispatchTurn(ctx, fixture.store, fixture.planner, fixture.authority, fixture.runner, fixture.request(1, 2, 2, true, ""), []string{"m1"}, map[string]bool{}, "sha256:"+"c", nowAt(12)); err != nil {
		t.Fatal(err)
	}
	conclusion, err := fixture.store.AssembleConclusion(ctx, fixture.discussion)
	if err != nil {
		t.Fatal(err)
	}
	if !conclusion.DisagreementKept {
		t.Fatal("conclusion must preserve disagreement, not invent consensus")
	}
	if conclusion.Recommendations[0].Recommendation == conclusion.Recommendations[1].Recommendation {
		t.Fatal("final positions must stay attributed, not merged")
	}
}

func TestUnfinishedScheduleCannotConclude(t *testing.T) {
	ctx := context.Background()
	fixture := setupDiscussion(t, 3)
	fixture.runner.byOrdinal[1] = scriptedTurn{session: "synthetic-session", output: validOutput("only")}
	if err := discussion.DispatchTurn(ctx, fixture.store, fixture.planner, fixture.authority, fixture.runner, fixture.request(0, 1, 1, true, ""), nil, map[string]bool{}, "sha256:"+"c", nowAt(11)); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.store.AssembleConclusion(ctx, fixture.discussion); err == nil || discussion.Code(err) != "conclusion_blocked" {
		t.Fatalf("want conclusion_blocked, got %v", err)
	}
}

// ABOUTME: Verifies generated Go discussion documents retain every causal and authority field on round trip.
// ABOUTME: Exercises conditional turn output and human-versus-participant views against shared synthetic fixtures.

package protocol_test

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func TestDiscussionTypedRoundTrips(t *testing.T) {
	root, err := protocol.RepositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		document string
		suffix   string
		value    any
	}{
		{"discussion-create-request", "synthetic", &generated.DiscussionCreateRequest{}},
		{"discussion-change-request", "decision", &generated.DiscussionChangeRequest{}},
		{"discussion-turn-request", "synthetic", &generated.DiscussionTurnRequest{}},
		{"discussion-turn-request", "complete", &generated.DiscussionTurnRequest{}},
		{"discussion-recommendation", "synthetic", &generated.DiscussionRecommendation{}},
		{"discussion-receipt", "synthetic", &generated.DiscussionReceipt{}},
		{"discussion-view", "synthetic", &generated.DiscussionView{}},
		{"discussion-view", "participant", &generated.DiscussionView{}},
	} {
		t.Run(test.document+"-"+test.suffix, func(t *testing.T) {
			data, err := os.ReadFile(protocol.FixturePath(root, "valid/"+test.document+".d01-"+test.suffix+".json"))
			if err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(data, test.value); err != nil {
				t.Fatal(err)
			}
			if turn, ok := test.value.(*generated.DiscussionTurnRequest); ok && turn.Action == "complete" {
				if turn.Output == nil || turn.SessionId == nil || turn.DeliveryId == nil || len(turn.Output.Evidence) != 2 || len(turn.Output.Disagreements) != 1 {
					t.Fatal("discussion turn lost session attribution or typed recommendation evidence")
				}
			}
			roundTrip, err := json.Marshal(test.value)
			if err != nil {
				t.Fatal(err)
			}
			want, got := protocol.DecodeWireDocument(test.document, data), protocol.DecodeWireDocument(test.document, roundTrip)
			if !want.OK || !got.OK || want.JSON != got.JSON {
				t.Fatal("generated discussion type did not retain its entire strict wire document")
			}
		})
	}
}

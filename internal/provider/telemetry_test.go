// ABOUTME: Validates explicitly identified usage and lifecycle telemetry candidates.
// ABOUTME: Rejects unsafe counters and invented delta quality while keeping legacy candidates usable.

package provider_test

import (
	"github.com/qdis/bfb/internal/provider"
	"testing"
)

func TestTelemetryCandidateBounds(t *testing.T) {
	count := int64(0)
	base := provider.Candidate{Kind: "usage", SessionID: "synthetic-session", UsageID: "synthetic-usage", Basis: "turn_delta", Quality: "provider_reported", InputTokens: &count}
	if err := base.Validate(); err != nil {
		t.Fatal("known zero rejected", err)
	}
	unavailable := base
	unavailable.InputTokens = nil
	unavailable.Quality = "unavailable"
	if err := unavailable.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*provider.Candidate){
		"missing-delta":     func(c *provider.Candidate) { c.Basis = "" },
		"cumulative":        func(c *provider.Candidate) { c.Basis = "cumulative" },
		"quality":           func(c *provider.Candidate) { c.Quality = "exact" },
		"unavailable-count": func(c *provider.Candidate) { c.Quality = "unavailable" },
		"all-null-present":  func(c *provider.Candidate) { c.InputTokens = nil },
		"missing-unit":      func(c *provider.Candidate) { c.UsageID = "" },
		"missing-session":   func(c *provider.Candidate) { c.SessionID = "" },
		"identity-kind":     func(c *provider.Candidate) { c.ActivityID = "turn" },
		"parent-kind":       func(c *provider.Candidate) { c.ParentTurnID = "turn" },
		"model":             func(c *provider.Candidate) { c.Model = "private model text" },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := base
			mutate(&candidate)
			if candidate.Validate() == nil {
				t.Fatal("invalid telemetry accepted")
			}
		})
	}
	for name, set := range map[string]func(*provider.Candidate, *int64){
		"input": func(c *provider.Candidate, n *int64) { c.InputTokens = n }, "output": func(c *provider.Candidate, n *int64) { c.OutputTokens = n }, "cache_read": func(c *provider.Candidate, n *int64) { c.CacheReadTokens = n }, "cache_write": func(c *provider.Candidate, n *int64) { c.CacheWriteTokens = n }, "reasoning": func(c *provider.Candidate, n *int64) { c.ReasoningTokens = n },
	} {
		for _, invalid := range []int64{-1, 9007199254740992} {
			t.Run(name, func(t *testing.T) {
				candidate := base
				set(&candidate, &invalid)
				if candidate.Validate() == nil {
					t.Fatal("unsafe counter accepted")
				}
			})
		}
	}
	legacy := provider.Candidate{Kind: "usage", InputTokens: &count}
	if legacy.Validate() != nil {
		t.Fatal("legacy usage invented a required identity")
	}
}

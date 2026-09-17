// ABOUTME: Enforces C08-mirroring input bounds, request identity, and offline policy decisions.
// ABOUTME: Rejects oversized, empty, or control-character payloads before any business effect.

package localmcp

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	maxRequestIDLen = 128
	minRequestIDLen = 8
	maxBodyLen      = 2048
	maxTitleLen     = 512
	maxIDLen        = 128
	// pendingTTLHours bounds how long a journaled operation may wait for replay.
	pendingTTLHours = 24
	// maxPendingPerRun bounds journaled operations per run.
	maxPendingPerRun = 256
)

// OfflineDecision is pending_sync (journal durably) or reject (visible failure).
type OfflineDecision string

const (
	OfflinePending OfflineDecision = "pending_sync"
	OfflineReject  OfflineDecision = "offline_rejected"
)

// OfflinePolicy decides, per tool, whether an unreachable cloud channel
// journals the mutation or fails visibly. Reads are never journaled.
type OfflinePolicy interface {
	Decide(tool string) OfflineDecision
}

// DefaultOfflinePolicy journals the four write tools and rejects the rest.
// Attention requests and reads need a live channel: a question is only
// useful inside a live waiter loop, so they fail visibly offline instead of
// queueing a stale question. Project policy may prohibit pending-sync
// entirely at merge; that switch lives behind this interface so L08/E01
// policy can replace it.
type DefaultOfflinePolicy struct{ AllowPending bool }

func (policy DefaultOfflinePolicy) Decide(tool string) OfflineDecision {
	switch tool {
	case "bfb_update_task", "bfb_add_comment", "bfb_report_progress", "bfb_propose_task":
		if policy.AllowPending {
			return OfflinePending
		}
	}
	return OfflineReject
}

func checkRequestID(value string) error {
	if len(value) < minRequestIDLen || len(value) > maxRequestIDLen || !utf8.ValidString(value) {
		return fail("invalid_request")
	}
	return nil
}

func checkID(value, field string) error {
	if value == "" || len(value) > maxIDLen || !utf8.ValidString(value) {
		return fail("invalid_request")
	}
	_ = field
	return nil
}

func boundedText(value, field string, maximum int) (string, error) {
	normalized := strings.TrimSpace(value)
	if normalized == "" || len([]rune(normalized)) > maximum || !utf8.ValidString(value) {
		return "", fail("invalid_params")
	}
	for _, character := range normalized {
		if unicode.IsControl(character) {
			return "", fail("invalid_params")
		}
	}
	return normalized, nil
}

func checkVersion(value float64) (int64, error) {
	version := int64(value)
	if float64(version) != value || version < 1 {
		return 0, fail("invalid_params")
	}
	return version, nil
}

func checkPriority(value string) (string, error) {
	switch value {
	case "P0", "P1", "P2", "P3":
		return value, nil
	default:
		return "", fail("invalid_params")
	}
}

// ABOUTME: Selects closed task and result contracts for the shared protected journal.
// ABOUTME: Reads only common capture metadata after exact family-specific validation.

package agentwork

import "encoding/json"

type journalCapture struct {
	Confirmation    json.RawMessage `json:"confirmation"`
	Operation       map[string]any  `json:"operation"`
	AdmissionMode   string          `json:"admission_mode"`
	CapturedAt      string          `json:"captured_at"`
	IntentExpiresAt *string         `json:"intent_expires_at"`
}

func journalFamily(tool string) (family, confirmationDocument, captureDocument, receiptDocument string, maxRequest int) {
	if tool == "bfb_submit_result" {
		return "agent_result", "agent-result-confirmation-result", "agent-result-capture", "agent-result-receipt", 32768
	}
	return "agent_work", "agent-capture-confirmation-result", "agent-work-capture", "agent-work-receipt", 16384
}

func journalReceiptDocument(intent journalIntent) string {
	_, _, _, document, _ := journalFamily(intent.Tool)
	return document
}

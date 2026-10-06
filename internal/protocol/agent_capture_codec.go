// ABOUTME: Applies bounds and business canonicalization to daemon-owned agent work documents.
// ABOUTME: Keeps captured-write identity separate from the frozen wire JSON representation.

package protocol

import (
	"fmt"
	"strings"
)

var captureByteLimits = map[string]int{
	"agent-result-request":               32768,
	"agent-result-local-request":         49152,
	"agent-result-result":                16384,
	"agent-result-confirmation-request":  2048,
	"agent-result-confirmation-result":   4096,
	"agent-result-capture":               8192,
	"agent-result-replay-request":        49152,
	"agent-result-receipt":               2048,
	"local-agent-result-rpc":             65536,
	"agent-capture-confirmation-request": 2048,
	"agent-capture-confirmation-result":  4096,
	"agent-work-capture":                 8192,
	"agent-work-replay-request":          32768,
	"agent-work-receipt":                 2048,
	"local-agent-work-rpc":               65536,
	"agent-attention-request":            16384,
	"agent-attention-read-request":       16384,
	"agent-attention-local-request":      32768,
	"agent-attention-read-local-request": 32768,
	"agent-attention-record":             32768,
	"agent-attention-result":             32768,
	"local-agent-attention-rpc":          65536,
}

func wireByteLimit(document string) int {
	if maximum, ok := captureByteLimits[document]; ok {
		return maximum
	}
	return maximumWireBytes
}

func captureDocumentBound(document string, root map[string]any, encoded string) bool {
	if _, ok := captureByteLimits[document]; !ok {
		return true
	}
	bounded := func(value any, maximum int) bool {
		canonical, err := stableJSON(value)
		return err == nil && len(canonical) <= maximum
	}
	captureBounded := func(value any, domain string) bool {
		capture, ok := value.(map[string]any)
		if !ok {
			return false
		}
		unsigned := make(map[string]any, len(capture)-1)
		for key, item := range capture {
			if key != "signature" {
				unsigned[key] = item
			}
		}
		canonical, err := stableJSON(unsigned)
		return err == nil && bounded(capture, 8192) && bounded(capture["confirmation"], 4096) &&
			len(domain+"\n"+canonical+"\n") <= 8192
	}
	if len(encoded) > wireByteLimit(document) {
		return false
	}
	switch document {
	case "agent-result-local-request":
		return bounded(root["request"], 32768)
	case "agent-result-capture":
		return captureBounded(root, "BFB-AGENT-RESULT-CAPTURE-V1")
	case "agent-result-replay-request":
		return captureBounded(root["capture"], "BFB-AGENT-RESULT-CAPTURE-V1") && bounded(root["original_request"], 32768)
	case "local-agent-result-rpc":
		if len(encoded)+1 > 65536 {
			return false
		}
		payload, _ := root["payload"].(map[string]any)
		if receipt, ok := payload["agent_result_receipt"]; ok && !bounded(receipt, 2048) {
			return false
		}
		if result, ok := payload["agent_result"]; ok && !bounded(result, 16384) {
			return false
		}
		if local, ok := payload["agent_result_request"].(map[string]any); ok && (!bounded(local, 49152) || !bounded(local["request"], 32768)) {
			return false
		}
	case "agent-attention-local-request", "agent-attention-read-local-request":
		return bounded(root["request"], 16384)
	case "local-agent-attention-rpc":
		if len(encoded)+1 > 65536 {
			return false
		}
		payload, _ := root["payload"].(map[string]any)
		if result, ok := payload["agent_attention"]; ok && !bounded(result, 32768) {
			return false
		}
		for _, field := range []string{"agent_attention_request", "agent_attention_read_request"} {
			if local, ok := payload[field].(map[string]any); ok && (!bounded(local, 32768) || !bounded(local["request"], 16384)) {
				return false
			}
		}
	case "agent-work-capture":
		return captureBounded(root, "BFB-AGENT-WORK-CAPTURE-V1")
	case "agent-work-replay-request":
		return captureBounded(root["capture"], "BFB-AGENT-WORK-CAPTURE-V1") && bounded(root["original_request"], 16384)
	case "local-agent-work-rpc":
		if len(encoded)+1 > 65536 {
			return false
		}
		payload, _ := root["payload"].(map[string]any)
		if receipt, ok := payload["agent_work_receipt"]; ok && !bounded(receipt, 2048) {
			return false
		}
		for _, field := range []string{"agent_comment_request", "agent_update_request", "agent_progress_request", "agent_proposal_request"} {
			if local, ok := payload[field].(map[string]any); ok {
				request, _ := local["request"].(map[string]any)
				if !bounded(request, 16384) {
					return false
				}
			}
		}
	}
	return true
}

var originalAgentWriteDocuments = map[string]string{
	"result.submit":      "agent-result-request",
	"agent_run.comment":  "agent-comment-request",
	"agent_run.update":   "agent-update-request",
	"agent_run.progress": "agent-progress-request",
	"agent_run.proposal": "agent-proposal-request",
}

// CanonicalAgentWriteRequest validates original business bytes without supplying omitted fields.
// Its literal Unicode separators match the domain's JSON.stringify-based business fingerprints.
func CanonicalAgentWriteRequest(commandName string, input []byte) (string, error) {
	document, ok := originalAgentWriteDocuments[commandName]
	if !ok {
		return "", fmt.Errorf("unknown agent write command")
	}
	maximum := 16384
	if commandName == "result.submit" {
		maximum = 32768
	}
	if len(input) > maximum {
		return "", fmt.Errorf("agent write exceeds the byte bound")
	}
	decoded := DecodeWireDocument(document, input)
	if !decoded.OK {
		return "", fmt.Errorf("agent write: %s", decoded.Error.Code)
	}
	canonical := literalJSONSeparators(decoded.JSON)
	if len(canonical) > maximum {
		return "", fmt.Errorf("agent write exceeds the byte bound")
	}
	return canonical, nil
}

// Skip escaped backslash pairs so a literal backslash-u2028 never changes its meaning.
func literalJSONSeparators(encoded string) string {
	var output strings.Builder
	for index := 0; index < len(encoded); index++ {
		if encoded[index] == '\\' && index+1 < len(encoded) {
			if encoded[index+1] == '\\' {
				output.WriteString(encoded[index : index+2])
				index++
				continue
			}
			if index+5 < len(encoded) && (encoded[index:index+6] == "\\u2028" || encoded[index:index+6] == "\\u2029") {
				if encoded[index+5] == '8' {
					output.WriteRune('\u2028')
				} else {
					output.WriteRune('\u2029')
				}
				index += 5
				continue
			}
		}
		output.WriteByte(encoded[index])
	}
	return output.String()
}

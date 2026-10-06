// ABOUTME: Checks the actual legacy MCP lifecycle independently of run authority.
// ABOUTME: Rejects premature tools and malformed negotiation without granting a capability.

package localmcp

import (
	"bufio"
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func wireReply(t *testing.T, harness *stdioHarness, request string) map[string]any {
	t.Helper()
	harness.stdout.Reset()
	harness.server.serveLine(context.Background(), bufio.NewWriter(harness.stdout), []byte(request))
	if harness.stdout.Len() == 0 {
		return nil
	}
	var reply map[string]any
	if err := json.Unmarshal(harness.stdout.Bytes(), &reply); err != nil {
		t.Fatal("invalid JSON-RPC response", err)
	}
	return reply
}

func TestStdioHandshakeLifecycle(t *testing.T) {
	harness, _ := happyHarness(nil)
	toolList := `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`
	toolCall := `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"bfb_get_task","arguments":{"request_id":"before-initialize"}}}`
	notification := `{"jsonrpc":"2.0","method":"notifications/initialized"}`
	if wireReply(t, harness, notification) != nil {
		t.Fatal("notification produced a response")
	}
	for _, request := range []string{toolList, toolCall} {
		assertBFBCode(t, wireReply(t, harness, request), "invalid_request")
	}
	if harness.server.capability.State() != StateProvisional {
		t.Fatal("premature tool activated authority")
	}
	initialized := wireReply(t, harness, validInitialize)
	result, ok := initialized["result"].(map[string]any)
	if !ok || result["protocolVersion"] != "2025-11-25" {
		t.Fatal("wrong handshake protocol", initialized)
	}
	assertBFBCode(t, wireReply(t, harness, toolList), "invalid_request")
	assertBFBCode(t, wireReply(t, harness, validInitialize), "invalid_request")
	if wireReply(t, harness, notification) != nil {
		t.Fatal("initialized notification produced a response")
	}
	if reply := wireReply(t, harness, toolList); reply["error"] != nil {
		t.Fatal("initialized tool listing rejected", reply)
	}
	if reply := wireReply(t, harness, toolCall); reply["error"] != nil {
		t.Fatal("initialized provisional read rejected", reply)
	}
	if harness.server.capability.State() != StateProvisional {
		t.Fatal("handshake or provisional read activated write authority")
	}
}

func TestStdioHandshakeValidationAndCounteroffer(t *testing.T) {
	for _, params := range []string{
		`{}`, `null`,
		`{"protocolVersion":17,"capabilities":{},"clientInfo":{"name":"test","version":"1"}}`,
		`{"protocolVersion":"2025-11-25","capabilities":null,"clientInfo":{"name":"test","version":"1"}}`,
		`{"protocolVersion":"2025-11-25","capabilities":[],"clientInfo":{"name":"test","version":"1"}}`,
		`{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"version":"1"}}`,
		`{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test"}}`,
	} {
		harness, _ := happyHarness(nil)
		assertBFBCode(t, wireReply(t, harness, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":`+params+`}`), "invalid_params")
		if reply := wireReply(t, harness, validInitialize); reply["error"] != nil {
			t.Fatal("malformed initialize poisoned subsequent valid negotiation")
		}
	}
	for _, requested := range []string{"2025-06-18", "2026-07-28", "unknown"} {
		harness, _ := happyHarness(nil)
		reply := wireReply(t, harness, strings.Replace(validInitialize, "2025-11-25", requested, 1))
		result, ok := reply["result"].(map[string]any)
		if !ok || result["protocolVersion"] != "2025-11-25" {
			t.Fatal("counteroffer advertised an unsupported protocol", reply)
		}
	}
}

func TestStdioPingAndModernDiscovery(t *testing.T) {
	harness, _ := happyHarness(nil)
	ping := `{"jsonrpc":"2.0","id":"heartbeat","method":"ping"}`
	assertPing := func() {
		t.Helper()
		reply := wireReply(t, harness, ping)
		result, ok := reply["result"].(map[string]any)
		if !ok || len(result) != 0 || reply["id"] != "heartbeat" {
			t.Fatal("ping did not return the empty transport response", reply)
		}
	}
	assertPing()
	assertBFBCode(t, wireReply(t, harness, `{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}}`), "method_not_found")
	harness.stdout.Reset()
	initializeHarness(t, harness)
	assertPing()
	if harness.server.capability.State() != StateProvisional {
		t.Fatal("transport methods activated write authority")
	}
	if harness.stderr.String() == "" {
		t.Fatal("missing bounded startup diagnostic")
	}
}

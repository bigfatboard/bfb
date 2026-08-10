// ABOUTME: Drives the real /mcp handler path for routing and cookie credential confusion.
// ABOUTME: Uses synthetic delegated tokens against migrated domain fixtures.

import { describe, expect, it } from "vitest";

import { FIX } from "../../../packages/domain/src/fixtures.js";
import { createDelegation, MCP_RESOURCE } from "../../../packages/domain/src/oauth.js";
import { issueStepUpProof } from "../../../packages/domain/src/step-up.js";
import { openDomainDb } from "../../../packages/domain/test/helpers.js";
import { handleMcpRequest } from "../src/mcp/handler.js";

describe("mcp handler", () => {
  it("lists tools without session state and rejects cookies", async () => {
    const db = await openDomainDb();
    const list = await handleMcpRequest(
      new Request("https://bfb.example.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/list",
          Host: "bfb.example.test",
        },
        body: JSON.stringify({ method: "tools/list" }),
      }),
      {
        db,
        allowedHostnames: ["bfb.example.test"],
        appOrigin: "https://bfb.example.test",
        now: "2026-08-07T12:00:00Z",
      },
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as { tools: Array<{ name: string }> };
    expect(body.tools.length).toBe(7);

    const cookie = await handleMcpRequest(
      new Request("https://bfb.example.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/call",
          "Mcp-Name": "bfb_list_tasks",
          Host: "bfb.example.test",
          cookie: "bfb_session=synthetic",
          authorization: "Bearer not-a-token",
        },
        body: JSON.stringify({
          method: "tools/call",
          name: "bfb_list_tasks",
          params: { arguments: {} },
        }),
      }),
      {
        db,
        allowedHostnames: ["bfb.example.test"],
        appOrigin: "https://bfb.example.test",
        now: "2026-08-07T12:00:00Z",
      },
    );
    expect(cookie.status).toBe(401);
  });

  it("proposes tasks through delegated MCP token via createMcpHandler path", async () => {
    const db = await openDomainDb();
    const action = {
      action: "oauth.delegation.create",
      clientId: FIX.client,
      resource: MCP_RESOURCE,
      workspaceId: FIX.workspace,
      projectId: FIX.projectA,
      scopes: ["bfb:read", "bfb:task:write"],
      authorizationEpoch: 1,
      expiresAt: "2026-08-07T13:00:00Z",
    };
    const proofId = await issueStepUpProof(db, FIX.owner, action, "2026-08-07T12:00:00Z");
    const { accessToken } = await createDelegation(db, {
      ...action,
      humanId: FIX.owner,
      now: "2026-08-07T12:00:01Z",
      stepUpProofId: proofId,
      scopes: action.scopes,
    });

    const response = await handleMcpRequest(
      new Request("https://bfb.example.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/call",
          "Mcp-Name": "bfb_propose_task",
          Host: "bfb.example.test",
          authorization: "Bearer " + accessToken,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "bfb_propose_task",
            arguments: {
              request_id: "mcp-1",
              project_id: FIX.projectA,
              title: "From MCP",
              priority: "P2",
            },
          },
        }),
      }),
      {
        db,
        allowedHostnames: ["bfb.example.test"],
        appOrigin: "https://bfb.example.test",
        now: "2026-08-07T12:01:00Z",
      },
    );
    expect(response.status).not.toBe(501);
    expect([200, 202]).toContain(response.status);
    const body = (await response.json()) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const text = body.result?.content?.[0]?.text ?? JSON.stringify(body);
    const parsed = JSON.parse(text) as {
      ok: boolean;
      result: { state: string; title: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.result.state).toBe("proposed");
    expect(parsed.result.title).toBe("From MCP");
  });
});

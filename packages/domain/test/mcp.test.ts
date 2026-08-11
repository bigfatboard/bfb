// ABOUTME: Covers X03A MCP routing metadata, tool map, and delegated tool parity with C08.
// ABOUTME: Legacy transport and mismatched headers fail closed before domain commands run.

import { describe, expect, it } from "vitest";

import { WorkspaceHub } from "../src/hub.js";
import { MCP_TOOL_NAMES, validateMcpRouting } from "../src/mcp-routing.js";
import {
  createDelegation,
  MCP_RESOURCE,
  resolveAccessToken,
  enforceDelegationAccess,
} from "../src/oauth.js";
import { issueStepUpProof } from "../src/step-up.js";
import { createTaskCommand, listTasks } from "../src/work-commands.js";
import { loadPrincipal } from "../src/authorization.js";
import { FIX } from "../src/fixtures.js";
import { openDomainDb } from "./helpers.js";

const policy = {
  allowedHostnames: ["bfb.example.test"],
  appOrigin: "https://bfb.example.test",
};

describe("mcp routing and tools", () => {
  it("accepts 2026-07-28 tools/list without Mcp-Name and requires name for tools/call", async () => {
    expect(
      validateMcpRouting(
        {
          protocolVersion: "2026-07-28",
          method: "tools/list",
          name: null,
          sessionId: null,
          host: "bfb.example.test",
          origin: null,
        },
        {},
        policy,
      ).method,
    ).toBe("tools/list");

    expect(() =>
      validateMcpRouting(
        {
          protocolVersion: "2026-07-28",
          method: "tools/call",
          name: null,
          sessionId: null,
          host: "bfb.example.test",
          origin: null,
        },
        {},
        policy,
      ),
    ).toThrow(/Mcp-Name required/);

    expect(() =>
      validateMcpRouting(
        {
          protocolVersion: "2026-07-28",
          method: "initialize",
          name: null,
          sessionId: null,
          host: "bfb.example.test",
          origin: null,
        },
        {},
        policy,
      ),
    ).toThrow(/initialize/);

    expect(() =>
      validateMcpRouting(
        {
          protocolVersion: "2026-07-28",
          method: "tools/list",
          name: null,
          sessionId: "sess",
          host: "bfb.example.test",
          origin: null,
        },
        {},
        policy,
      ),
    ).toThrow(/Session-Id/);
  });

  it("exposes exactly seven tools and runs propose through shared domain command", async () => {
    expect([...MCP_TOOL_NAMES]).toEqual([
      "bfb_list_projects",
      "bfb_list_tasks",
      "bfb_get_task",
      "bfb_get_context",
      "bfb_add_comment",
      "bfb_report_progress",
      "bfb_propose_task",
    ]);

    const db = await openDomainDb();
    const action = {
      action: "oauth.delegation.create",
      clientId: FIX.client,
      resource: MCP_RESOURCE,
      workspaceId: FIX.workspace,
      projectId: FIX.projectA,
      scopes: ["bfb:read", "bfb:task:write"],
      authorizationEpoch: 1,
      expiresAt: "2026-08-07T12:10:00Z",
    };
    const proofId = await issueStepUpProof(db, FIX.owner, action, "2026-08-07T12:00:00Z");
    const { accessToken } = await createDelegation(db, {
      ...action,
      humanId: FIX.owner,
      now: "2026-08-07T12:00:01Z",
      stepUpProofId: proofId,
      scopes: action.scopes,
    });
    const delegation = await resolveAccessToken(db, accessToken, "2026-08-07T12:01:00Z");
    const hub = new WorkspaceHub(db);
    const proposed = await hub.execute(createTaskCommand, {
      workspaceId: delegation.workspaceId,
      idempotencyKey: "mcp-propose",
      authorizationEpoch: delegation.authorizationEpoch,
      actorHumanId: delegation.humanId,
      actorDelegationId: delegation.delegationId,
      input: {
        projectId: FIX.projectA,
        title: "MCP proposed task",
        priority: "P2",
        actorIsAgent: true,
      },
    });
    expect(proposed.ok && proposed.result.state).toBe("proposed");
    const principal = await loadPrincipal(db, FIX.workspace, FIX.owner);
    const tasks = await listTasks(db, FIX.workspace, principal.projectIds);
    expect(tasks.some((task) => task.title === "MCP proposed task")).toBe(true);
  });

  it("intersects membership with delegation project scope", async () => {
    const db = await openDomainDb();
    const action = {
      action: "oauth.delegation.create",
      clientId: FIX.client,
      resource: MCP_RESOURCE,
      workspaceId: FIX.workspace,
      projectId: FIX.projectA,
      scopes: ["bfb:read", "bfb:task:write"],
      authorizationEpoch: 1,
      expiresAt: "2026-08-07T12:10:00Z",
    };
    const proofId = await issueStepUpProof(db, FIX.restricted, action, "2026-08-07T12:00:00Z");
    const { accessToken } = await createDelegation(db, {
      ...action,
      humanId: FIX.restricted,
      now: "2026-08-07T12:00:01Z",
      stepUpProofId: proofId,
      scopes: action.scopes,
    });
    const delegation = await resolveAccessToken(db, accessToken, "2026-08-07T12:01:00Z");
    await expect(enforceDelegationAccess(db, delegation, FIX.projectA)).resolves.toBeUndefined();
    await expect(enforceDelegationAccess(db, delegation, FIX.projectB)).rejects.toThrow(
      /project not permitted|project outside/,
    );
  });

  it("rejects foreign origins and hosts", async () => {
    expect(() =>
      validateMcpRouting(
        {
          protocolVersion: "2026-07-28",
          method: "tools/list",
          name: null,
          sessionId: null,
          host: "evil.example",
          origin: null,
        },
        {},
        policy,
      ),
    ).toThrow(/Host/);
    expect(() =>
      validateMcpRouting(
        {
          protocolVersion: "2026-07-28",
          method: "tools/list",
          name: null,
          sessionId: null,
          host: "bfb.example.test",
          origin: "https://evil.example",
        },
        {},
        policy,
      ),
    ).toThrow(/Origin/);
  });
});

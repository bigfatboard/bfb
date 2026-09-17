// ABOUTME: Drives the X03A OAuth project boundary and real WebAuthn checkpoint in Chromium.
// ABOUTME: The approved request reaches Better Auth consent only after a one-time passkey proof.

import { expect, request as apiRequest, test } from "@playwright/test";
import { createServer } from "node:http";

import { FIX } from "@bfb/domain";

import { signInAs } from "./helpers.js";
import { enrollVirtualPasskey } from "./webauthn-helpers.js";

test("human narrows a Claude OAuth request before provider consent", async ({ page }) => {
  await signInAs(page, "owner");
  const origin = new URL(page.url()).origin;
  const { cleanup } = await enrollVirtualPasskey(page);
  try {
    const authorize = new URL("/oauth/authorize", origin);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: "bfb-claude-code",
      redirect_uri: "http://localhost:9999/callback",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      scope: "bfb:read bfb:task:write offline_access",
      resource: `${origin}/mcp`,
      state: "x03a-browser-state",
    })) {
      authorize.searchParams.set(key, value);
    }

    await page.goto(authorize.toString());
    await expect(
      page.getByRole("heading", { name: "Choose what Claude Code can touch." }),
    ).toBeVisible();
    await expect(
      page.getByText("It does not make the client an agent", { exact: false }),
    ).toBeVisible();
    await page.locator("#workspace").selectOption(FIX.workspace);
    await expect(page.locator("#project")).toBeEnabled();
    await page.locator("#project").selectOption(FIX.projectA);
    await page.getByRole("button", { name: "Verify passkey & authorize" }).click();

    await expect(page.getByRole("heading", { name: "Authorize Claude Code" })).toBeVisible();
    await expect(page.getByText("Alpha")).toBeVisible();
    await expect(page.getByText("bfb:read, bfb:task:write, offline_access")).toBeVisible();

    const callbackServer = await startCallbackServer();
    await page.getByRole("button", { name: "Authorize", exact: true }).click();
    const callback = new URL(await callbackServer.url);
    await callbackServer.close();
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(callback.searchParams.get("state")).toBe("x03a-browser-state");
    expect(callback.searchParams.get("iss")).toBe(`${origin}/auth`);

    const api = await apiRequest.newContext({ baseURL: origin });
    try {
      const token = await api.post("/oauth/token", {
        form: {
          grant_type: "authorization_code",
          code: code!,
          redirect_uri: "http://localhost:9999/callback",
          client_id: "bfb-claude-code",
          code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
          resource: `${origin}/mcp`,
        },
      });
      expect(token.status(), await token.text()).toBe(200);
      const tokenBody = (await token.json()) as { access_token: string };
      const tools = await mcpTools(api, tokenBody.access_token);
      expect(tools.status(), await tools.text()).toBe(200);
      const toolsBody = (await tools.json()) as {
        result?: { tools?: Array<{ name: string }> };
      };
      expect(toolsBody.result?.tools?.map((tool) => tool.name).sort()).toEqual([
        "bfb_add_comment",
        "bfb_finalize_artifact",
        "bfb_get_attention",
        "bfb_get_context",
        "bfb_get_task",
        "bfb_list_projects",
        "bfb_list_tasks",
        "bfb_propose_task",
        "bfb_publish_artifact",
        "bfb_report_progress",
        "bfb_request_human",
        "bfb_submit_result",
      ]);
      const revoked = await api.post("/oauth/revoke", {
        form: {
          client_id: "bfb-claude-code",
          token: tokenBody.access_token,
          token_type_hint: "access_token",
        },
      });
      expect(revoked.status()).toBe(200);
      expect((await mcpTools(api, tokenBody.access_token)).status()).toBe(401);
    } finally {
      await api.dispose();
    }
  } finally {
    await cleanup();
  }
});

async function startCallbackServer(): Promise<{
  url: Promise<string>;
  close: () => Promise<void>;
}> {
  let resolveUrl: (url: string) => void = () => undefined;
  const url = new Promise<string>((resolve) => {
    resolveUrl = resolve;
  });
  const server = createServer((request, response) => {
    resolveUrl(`http://localhost:9999${request.url ?? "/callback"}`);
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("BFB authorization returned");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "::", port: 9999, ipv6Only: false }, resolve);
  });
  return {
    url,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function mcpTools(api: Awaited<ReturnType<typeof apiRequest.newContext>>, accessToken: string) {
  return api.post("/mcp", {
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/list",
    },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "claude-code", version: "2.1.224" },
        },
      },
    },
  });
}

test("OAuth checkpoint rejects a client with an unregistered redirect", async ({ page }) => {
  await signInAs(page, "owner");
  const origin = new URL(page.url()).origin;
  const authorize = new URL("/oauth/authorize", origin);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: "bfb-claude-code",
    redirect_uri: "http://localhost:9999/not-the-callback",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    scope: "bfb:read bfb:task:write offline_access",
    resource: `${origin}/mcp`,
    state: "x03a-bad-redirect",
  })) {
    authorize.searchParams.set(key, value);
  }
  const response = await page.goto(authorize.toString());
  expect(response?.status()).toBe(400);
  await expect(page.getByText("invalid_redirect")).toBeVisible();
});

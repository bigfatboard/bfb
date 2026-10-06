// ABOUTME: Hosts production MCP routes beside a test-only direct Hub dispatch surface.
// ABOUTME: Disposable fixtures can attack queued authority without bypassing it in deployed code.

import { createFetchHandler } from "@bfb/control-worker";
import { FIX } from "@bfb/domain";

interface FixtureEnv {
  WORKSPACE_HUB: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(url: string, init: RequestInit): Promise<Response> };
  };
}

export default {
  async fetch(request: Request, env: unknown): Promise<Response> {
    if (request.method === "POST" && new URL(request.url).pathname === "/__x03/hub") {
      const namespace = (env as FixtureEnv).WORKSPACE_HUB;
      return namespace
        .get(namespace.idFromName(FIX.workspace))
        .fetch("https://bfb-hub.internal/execute", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await request.text(),
        });
    }
    // Wrangler's Node bridge replaces Host with its loopback transport address.
    // Restore the preserved request URL's authority for the SDK Host check.
    // Host/Origin attacks remain covered by the unmodified handler gate.
    const headers = new Headers(request.headers);
    headers.set("host", new URL(request.url).host);
    return createFetchHandler()(new Request(request, { headers }), env as never);
  },
};

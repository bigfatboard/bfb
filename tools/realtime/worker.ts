// ABOUTME: Proxies E02 hub commands and browser upgrades to one external WorkspaceHub.
// ABOUTME: The production Durable Object owns serialization, sockets, and dispatch for the test.

interface HubNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): {
    fetch(input: string, init: RequestInit): Promise<Response>;
  };
}

interface RealtimeTestEnv {
  WORKSPACE_HUB: HubNamespace;
}

export default {
  async fetch(request: Request, env: RealtimeTestEnv): Promise<Response> {
    const url = new URL(request.url);
    const execute = url.pathname.match(/^\/workspaces\/([^/]+)\/execute$/);
    if (request.method === "POST" && execute?.[1]) {
      const id = env.WORKSPACE_HUB.idFromName(execute[1]);
      return env.WORKSPACE_HUB.get(id).fetch("https://bfb-hub.internal/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: await request.text(),
      });
    }
    const connect = url.pathname.match(/^\/realtime-test\/([^/]+)\/connect$/);
    if (request.method === "GET" && connect?.[1]) {
      const principal = request.headers.get("x-bfb-browser-principal");
      const protocol = request.headers.get("sec-websocket-protocol");
      if (
        request.headers.get("Upgrade") !== "websocket" ||
        protocol !== "bfb.browser.v1" ||
        !principal
      ) {
        return Response.json({ error: "request_rejected" }, { status: 403 });
      }
      const id = env.WORKSPACE_HUB.idFromName(connect[1]);
      return env.WORKSPACE_HUB.get(id).fetch("https://bfb-hub.internal/browser/connect", {
        method: "GET",
        headers: {
          upgrade: "websocket",
          "sec-websocket-protocol": protocol,
          "x-bfb-browser-principal": principal,
        },
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
};

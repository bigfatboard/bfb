// ABOUTME: Proxies C07 commands from independent Worker isolates to one external WorkspaceHub.
// ABOUTME: The production Durable Object owns serialization and command dispatch for the test.

interface HubNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): {
    fetch(input: string, init: RequestInit): Promise<Response>;
  };
}

interface ProjectWorkerEnv {
  WORKSPACE_HUB: HubNamespace;
}

export default {
  async fetch(request: Request, env: ProjectWorkerEnv): Promise<Response> {
    const match = new URL(request.url).pathname.match(/^\/workspaces\/([^/]+)\/execute$/);
    if (request.method !== "POST" || !match?.[1]) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const id = env.WORKSPACE_HUB.idFromName(match[1]);
    return env.WORKSPACE_HUB.get(id).fetch("https://bfb-hub.internal/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await request.text(),
    });
  },
};

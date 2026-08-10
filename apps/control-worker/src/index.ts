// ABOUTME: Hosts the BFB Control Worker entrypoint with validated bindings and route shells.
// ABOUTME: Product auth, hub commands, and MCP behavior remain owned by later packages.

import { createControlApp } from "./routes.js";
import { validateControlEnv, type ControlBindings } from "./env.js";
export { WorkspaceHub } from "./workspace-hub.js";

export default {
  async fetch(request: Request, env: ControlBindings): Promise<Response> {
    try {
      const validated = validateControlEnv(env);
      const app = createControlApp(validated);
      return await app.fetch(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid_environment";
      return new Response(JSON.stringify({ ok: false, error: "config_invalid", message }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
  },
};

// Disposable Better Auth compatibility spike marker. No auth routes are mounted here.
export const BETTER_AUTH_SPIKE_VERSION = "1.6.26";

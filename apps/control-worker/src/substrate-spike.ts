// ABOUTME: Loads the pinned Better Auth spike beside D1 and the SQLite Durable Object in Workerd.
// ABOUTME: Exposes one disposable probe path and no authentication or product routes.

import { createDisposableBetterAuthSpike } from "./better-auth-spike.js";
export { WorkspaceHub } from "./workspace-hub.js";

interface SubstrateSpikeBindings {
  DB: D1Database;
  WORKSPACE_HUB: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: SubstrateSpikeBindings): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== "/_substrate-spike") {
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    if (!env.DB || !env.WORKSPACE_HUB) {
      return Response.json({ ok: false, error: "missing_binding" }, { status: 500 });
    }
    const d1 = await env.DB.prepare("SELECT 1 AS value").first<{ value: number }>();
    if (d1?.value !== 1) {
      return Response.json({ ok: false, error: "d1_probe_failed" }, { status: 500 });
    }
    const spike = createDisposableBetterAuthSpike();
    return Response.json({ ok: spike.hasHandler, version: spike.version, d1: true });
  },
};

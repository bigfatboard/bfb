// ABOUTME: Runs production artifact browser routes with a test-only controllable clock.
// ABOUTME: Independent isolates share D1 and an external production WorkspaceHub lane.

import { createFetchHandler } from "@bfb/control-worker";
import { ARTIFACT_RECOVERY_SYSTEM_ID, FIX, isUlid } from "@bfb/domain";

interface AuditFixtureEnv {
  WORKSPACE_HUB: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(url: string, init: RequestInit): Promise<Response> };
  };
}

export default {
  async fetch(request: Request, env: unknown): Promise<Response> {
    const path = new URL(request.url).pathname;
    // This fixture-only route invokes the same closed system command as Cron.
    // Neither this route nor the clock header exists in the deployed Worker.
    if (request.method === "POST" && path.startsWith("/__v02/audit/")) {
      const sourceId = path.slice("/__v02/audit/".length);
      if (!isUlid(sourceId)) return new Response(null, { status: 400 });
      const namespace = (env as AuditFixtureEnv).WORKSPACE_HUB;
      const response = await namespace
        .get(namespace.idFromName(FIX.workspace))
        .fetch("https://bfb-hub.internal/execute", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandName: "artifact.dispatch_audit",
            request: {
              workspaceId: FIX.workspace,
              actorSystemId: ARTIFACT_RECOVERY_SYSTEM_ID,
              authorizationEpoch: 1,
              idempotencyKey: `artifact-audit:${sourceId}`,
              input: { outboxId: sourceId },
            },
          }),
        });
      if (request.headers.get("x-v02-drop-audit-reply") === "1") {
        await response.arrayBuffer();
        return Response.json({ error: "synthetic_lost_reply" }, { status: 503 });
      }
      return response;
    }
    const now = request.headers.get("x-v02-test-time") ?? "2026-09-17T12:00:00.000Z";
    return createFetchHandler({ now })(request, env as never);
  },
};

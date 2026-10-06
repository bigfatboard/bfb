// ABOUTME: Runs production artifact browser routes with a test-only controllable clock.
// ABOUTME: Independent isolates share D1 and an external production WorkspaceHub lane.

import { createFetchHandler } from "@bfb/control-worker";
import { ARTIFACT_RECOVERY_SYSTEM_ID, FIX, isUlid, randomUlid } from "@bfb/domain";

interface RecoveryFixtureEnv {
  WORKSPACE_HUB: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(url: string, init: RequestInit): Promise<Response> };
  };
}

export default {
  async fetch(request: Request, env: unknown): Promise<Response> {
    const path = new URL(request.url).pathname;
    const recovery = path.startsWith("/__v01/recover/");
    const audit = path.startsWith("/__v01/audit/");
    if (request.method === "POST" && (recovery || audit)) {
      const sourceId = path.slice(recovery ? "/__v01/recover/".length : "/__v01/audit/".length);
      if (!isUlid(sourceId)) return new Response(null, { status: 400 });
      const namespace = (env as RecoveryFixtureEnv).WORKSPACE_HUB;
      const response = await namespace
        .get(namespace.idFromName(FIX.workspace))
        .fetch("https://bfb-hub.internal/execute", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandName: recovery ? "artifact.mark_failed" : "artifact.dispatch_audit",
            request: {
              workspaceId: FIX.workspace,
              actorSystemId: ARTIFACT_RECOVERY_SYSTEM_ID,
              authorizationEpoch: 1,
              idempotencyKey: recovery ? randomUlid() : `artifact-audit:${sourceId}`,
              input: recovery ? { versionId: sourceId } : { outboxId: sourceId },
            },
          }),
        });
      if (audit && request.headers.get("x-v01-drop-audit-reply") === "1") {
        await response.arrayBuffer();
        return Response.json({ error: "synthetic_lost_reply" }, { status: 503 });
      }
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      return new Response(response.body, { status: response.status, headers });
    }
    const now = request.headers.get("x-v01-test-time") ?? "2026-09-17T12:00:00.000Z";
    return createFetchHandler({ now })(request, env as never);
  },
};

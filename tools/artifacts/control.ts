// ABOUTME: Runs production artifact browser routes with a test-only controllable clock.
// ABOUTME: Independent isolates share D1 and an external production WorkspaceHub lane.

import { createFetchHandler } from "@bfb/control-worker";

export default {
  async fetch(request: Request, env: unknown): Promise<Response> {
    const now = request.headers.get("x-v01-test-time") ?? "2026-09-17T12:00:00.000Z";
    return createFetchHandler({ now })(request, env as never);
  },
};

// ABOUTME: Runs production launch routes with a test-only controllable clock in disposable Workerd.
// ABOUTME: Independent isolates share D1 and an external production WorkspaceHub with no mock command lane.

import { createFetchHandler } from "@bfb/control-worker";

export default {
  async fetch(request: Request, env: unknown): Promise<Response> {
    const now = request.headers.get("x-c09-test-time") ?? "2026-09-12T12:00:00.000Z";
    return createFetchHandler({ now })(request, env as never);
  },
};

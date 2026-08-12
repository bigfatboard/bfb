// ABOUTME: Runs the production Control Worker with deterministic C04 verification time.
// ABOUTME: Two configured isolates share D1 workspace-authorization abuse state.

import { createFetchHandler } from "@bfb/control-worker";

export { WorkspaceHub } from "@bfb/control-worker";

const fetchControl = createFetchHandler({ now: "2026-08-11T20:00:00.000Z" });

export default {
  async fetch(request: Request, env: unknown): Promise<Response> {
    return fetchControl(request, env as never);
  },
};

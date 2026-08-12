// ABOUTME: Runs the production Control Worker with deterministic C03 verification time.
// ABOUTME: Two configured isolates share D1 passkey challenges and abuse-control state.

import { createFetchHandler } from "@bfb/control-worker";

export { WorkspaceHub } from "@bfb/control-worker";

const fetchControl = createFetchHandler({ now: "2026-08-11T20:00:00Z" });

export default {
  async fetch(request: Request, env: unknown): Promise<Response> {
    return fetchControl(request, env as never);
  },
};

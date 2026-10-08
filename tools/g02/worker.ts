// ABOUTME: Serves the production control Worker surface for G02 release smoke.
// ABOUTME: Synthetic secrets only; every mutation stays on disposable local D1.

import { createFetchHandler, WorkspaceHub } from "@bfb/control-worker";

export { WorkspaceHub };

const fetchControl = createFetchHandler({ now: "2026-09-18T12:00:00.000Z" });

export default {
  async fetch(request: Request, env: unknown): Promise<Response> {
    return fetchControl(request, env as never);
  },
};

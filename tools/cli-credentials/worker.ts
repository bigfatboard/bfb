// ABOUTME: Executes the production CLI credential routes with deterministic C05 time.
// ABOUTME: Separate scripts share canonical D1 and dispatch mutations to one external hub.

import { createFetchHandler } from "@bfb/control-worker";

const fetchControl = createFetchHandler({ now: "2026-09-12T20:00:00.000Z" });

export default {
  async fetch(request: Request, env: unknown): Promise<Response> {
    return fetchControl(request, env as never);
  },
};

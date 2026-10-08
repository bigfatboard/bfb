// ABOUTME: Executes the production X02 human CLI surface across two Worker isolates.
// ABOUTME: Synthetic identities only; the external hub owns every domain mutation.

import { createFetchHandler } from "@bfb/control-worker";

const fetchControl = createFetchHandler({ now: "2026-08-18T12:00:00.000Z" });

export default {
  async fetch(request: Request, env: unknown): Promise<Response> {
    return fetchControl(request, env as never);
  },
};

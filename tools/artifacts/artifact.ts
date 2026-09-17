// ABOUTME: Runs the production Artifact Worker upload path with a controllable clock.
// ABOUTME: Real D1 batches and the disposable R2 binding prove the V01 state machine.

import { createArtifactFetchHandler } from "@bfb/artifact-worker";

export default {
  async fetch(request: Request, env: unknown): Promise<Response> {
    const now = request.headers.get("x-v01-test-time") ?? "2026-09-17T12:00:00.000Z";
    return createArtifactFetchHandler({ now })(request, env as never);
  },
};

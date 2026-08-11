// ABOUTME: Exposes the C01 abuse counter inside Workerd for integration verification.
// ABOUTME: The test Worker uses the production D1 adapter and domain service unchanged.

import { adaptD1 } from "@bfb/db";
import { consumeRateLimit } from "@bfb/domain";

interface KernelEnv {
  DB: Parameters<typeof adaptD1>[0];
}

export default {
  async fetch(request: Request, env: KernelEnv): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }
    const body = (await request.json()) as {
      bucketKey: string;
      now: string;
      limit: number;
      windowSeconds: number;
    };
    const decision = await consumeRateLimit(
      adaptD1(env.DB),
      body.bucketKey,
      body.now,
      body.limit,
      body.windowSeconds,
    );
    return Response.json(decision);
  },
};

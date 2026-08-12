// ABOUTME: Disposable compile-time spike proving Better Auth 1.6.26 resolves with Worker types.
// ABOUTME: Enables no routes, creates no tables, and leaves no product auth configuration.

import { betterAuth } from "better-auth";

/**
 * Builds an inert Better Auth instance for dependency/runtime compatibility checks.
 * Callers must not mount this on any Worker route.
 */
export function createDisposableBetterAuthSpike(): { version: string; hasHandler: boolean } {
  const auth = betterAuth({
    baseURL: "https://bfb.example.test",
    secret: "synthetic-spike-secret-not-for-production-use",
    // Explicitly empty social providers and no database adapter in this spike.
  });
  return {
    version: "1.6.26",
    hasHandler: typeof auth.handler === "function",
  };
}

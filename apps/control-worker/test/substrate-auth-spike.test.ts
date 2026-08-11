// ABOUTME: Executes the inert Better Auth compatibility spike owned by F03.
// ABOUTME: Confirms the pinned package constructs without mounting routes or database behavior.

import { describe, expect, it } from "vitest";

import { createDisposableBetterAuthSpike } from "../src/better-auth-spike.js";

describe("disposable Better Auth compatibility spike", () => {
  it("constructs the pinned handler without product configuration", () => {
    expect(createDisposableBetterAuthSpike()).toEqual({
      version: "1.6.26",
      hasHandler: true,
    });
  });
});

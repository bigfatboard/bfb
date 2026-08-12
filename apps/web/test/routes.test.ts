// ABOUTME: Guards SPA path ownership so Static Assets cannot shadow Worker-first routes.
// ABOUTME: Uses the shipped isSpaAssetPath helper against architecture route examples.

import { describe, expect, it } from "vitest";

import {
  isSpaAssetPath,
  SPA_ALLOWED_PATH_EXAMPLES,
  WORKER_FIRST_PATH_EXAMPLES,
} from "../src/routes.js";

describe("spa path ownership", () => {
  it("allows ordinary app paths", () => {
    for (const path of SPA_ALLOWED_PATH_EXAMPLES) {
      expect(isSpaAssetPath(path)).toBe(true);
    }
  });

  it("never claims worker-first routes", () => {
    for (const path of WORKER_FIRST_PATH_EXAMPLES) {
      expect(isSpaAssetPath(path)).toBe(false);
    }
  });
});

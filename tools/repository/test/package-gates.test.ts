// ABOUTME: Exercises exact done-package gate selection and command-shape rejection.
// ABOUTME: Proves planned packages are skipped and shared targets run only once.

import { describe, expect, test } from "vitest";

import { packageGates } from "../src/package-gates.js";
import type { WorkPackage } from "../src/roadmap.js";

function workPackage(id: string, status: string, testTarget: string | undefined): WorkPackage {
  return {
    id,
    title: id,
    status,
    risk: "Medium",
    filename: "WP-" + id + ".md",
    requires: [],
    unlocks: [],
    testTarget,
    evidenceManifest: undefined,
    consumes: "input",
    produces: "output",
  };
}

describe("done package gates", () => {
  test("selects exact done targets once in roadmap order", () => {
    expect(
      packageGates([
        workPackage("F01", "done", "pnpm verify"),
        workPackage("F02", "planned", "pnpm test:protocol"),
        workPackage("F03", "done", "pnpm test:substrate"),
        workPackage("F04", "done", "pnpm test:substrate"),
      ]),
    ).toEqual([
      { command: "pnpm", args: ["verify"], packages: ["F01"] },
      { command: "pnpm", args: ["test:substrate"], packages: ["F03", "F04"] },
    ]);
  });

  test("rejects shell expressions and missing targets", () => {
    expect(() => packageGates([workPackage("F01", "done", "pnpm test && echo nope")])).toThrow(
      "unsupported test target",
    );
    expect(() => packageGates([workPackage("F01", "done", undefined)])).toThrow(
      "without a test target",
    );
  });
});

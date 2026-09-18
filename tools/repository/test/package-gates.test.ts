// ABOUTME: Exercises exact done-package gate selection and command-shape rejection.
// ABOUTME: Proves planned packages are skipped and shared targets run only once.

import { describe, expect, test } from "vitest";

import { planPackageGates } from "../src/package-gates.js";
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
  const scripts = new Set(["verify", "test:protocol", "test:substrate", "test:l04", "test:l05"]);

  test("selects exact done targets once in roadmap order", () => {
    expect(
      planPackageGates(
        [
          workPackage("F01", "done", "pnpm verify"),
          workPackage("F02", "planned", "pnpm test:protocol"),
          workPackage("F03", "done", "pnpm test:substrate"),
          workPackage("F04", "done", "pnpm test:substrate"),
        ],
        scripts,
        "darwin",
      ).run,
    ).toEqual([
      { command: "pnpm", args: ["verify"], packages: ["F01"] },
      { command: "pnpm", args: ["test:substrate"], packages: ["F03", "F04"] },
    ]);
  });

  test("rejects shell expressions and missing targets", () => {
    expect(() =>
      planPackageGates([workPackage("F01", "done", "pnpm test && echo nope")], scripts, "darwin"),
    ).toThrow("unsupported test target");
    expect(() =>
      planPackageGates([workPackage("F01", "done", undefined)], scripts, "darwin"),
    ).toThrow("without a test target");
    expect(() =>
      planPackageGates([workPackage("F01", "done", "pnpm packages:verify")], scripts, "darwin"),
    ).toThrow("cannot use the package gate runner");
    expect(() =>
      planPackageGates([workPackage("F01", "done", "pnpm install")], scripts, "darwin"),
    ).toThrow("not a root package script");
  });

  test("runs macOS-only gates on darwin without skips", () => {
    const plan = planPackageGates(
      [
        workPackage("L04", "done", "pnpm test:l04"),
        workPackage("L05", "done", "pnpm test:l05"),
        workPackage("L06", "done", "pnpm test:substrate"),
      ],
      scripts,
      "darwin",
    );
    expect(plan.run).toEqual([
      { command: "pnpm", args: ["test:l04"], packages: ["L04"] },
      { command: "pnpm", args: ["test:l05"], packages: ["L05"] },
      { command: "pnpm", args: ["test:substrate"], packages: ["L06"] },
    ]);
    expect(plan.skipped).toEqual([]);
  });

  test("skips macOS-only gates off darwin instead of running their darwin assertion", () => {
    const plan = planPackageGates(
      [
        workPackage("L04", "done", "pnpm test:l04"),
        workPackage("L05", "done", "pnpm test:l05"),
        workPackage("L06", "done", "pnpm test:substrate"),
      ],
      scripts,
      "linux",
    );
    expect(plan.run).toEqual([{ command: "pnpm", args: ["test:substrate"], packages: ["L06"] }]);
    expect(plan.skipped).toEqual([
      { command: "pnpm", args: ["test:l04"], packages: ["L04"] },
      { command: "pnpm", args: ["test:l05"], packages: ["L05"] },
    ]);
  });
});

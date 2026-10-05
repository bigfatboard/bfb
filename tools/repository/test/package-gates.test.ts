// ABOUTME: Exercises exact done-package gate selection and command-shape rejection.
// ABOUTME: Keeps platform skips separate from runnable gates and ignores unfinished packages.

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
  const scripts = new Set([
    "verify",
    "test:protocol",
    "test:substrate",
    "test:a01",
    "test:a02",
    "test:l04",
    "test:l05",
  ]);

  test("selects exact done targets once in roadmap order", () => {
    expect(
      planPackageGates(
        [
          workPackage("F01", "done", "pnpm verify"),
          workPackage("F02", "planned", "pnpm test:protocol"),
          workPackage("F03", "done", "pnpm test:substrate"),
          workPackage("F04", "done", "pnpm test:substrate"),
          workPackage("A01", "in_progress", "pnpm test:a01"),
          workPackage("A02", "in_progress", "pnpm test:a02"),
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
        workPackage("A01", "done", "pnpm test:a01"),
        workPackage("A02", "done", "pnpm test:a02"),
      ],
      scripts,
      "darwin",
    );
    expect(plan.run).toEqual([
      { command: "pnpm", args: ["test:l04"], packages: ["L04"] },
      { command: "pnpm", args: ["test:l05"], packages: ["L05"] },
      { command: "pnpm", args: ["test:substrate"], packages: ["L06"] },
      { command: "pnpm", args: ["test:a01"], packages: ["A01"] },
      { command: "pnpm", args: ["test:a02"], packages: ["A02"] },
    ]);
    expect(plan.skipped).toEqual([]);
  });

  test.each(["linux", "win32", "freebsd"])(
    "skips macOS-only gates on %s instead of running their darwin assertion",
    (platform) => {
      const plan = planPackageGates(
        [
          workPackage("L04", "done", "pnpm test:l04"),
          workPackage("L05", "done", "pnpm test:l05"),
          workPackage("L06", "done", "pnpm test:substrate"),
          workPackage("A01", "done", "pnpm test:a01"),
          workPackage("A02", "done", "pnpm test:a02"),
        ],
        scripts,
        platform,
      );
      expect(plan.run).toEqual([{ command: "pnpm", args: ["test:substrate"], packages: ["L06"] }]);
      expect(plan.skipped).toEqual([
        { command: "pnpm", args: ["test:l04"], packages: ["L04"] },
        { command: "pnpm", args: ["test:l05"], packages: ["L05"] },
        { command: "pnpm", args: ["test:a01"], packages: ["A01"] },
        { command: "pnpm", args: ["test:a02"], packages: ["A02"] },
      ]);
    },
  );
});

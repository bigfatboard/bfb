// ABOUTME: Exercises exact done-package gate selection and command-shape rejection.
// ABOUTME: Keeps platform skips separate from runnable gates and ignores unfinished packages.

import { readFileSync } from "node:fs";

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
    "test:a03",
    "test:a04",
    "test:v01",
    "test:l04",
    "test:l05",
  ]);

  test("keeps mounted telemetry ingest tests in the exact A04 target", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    const focusedTests = (manifest.scripts["test:a04"] ?? "")
      .split("&&")
      .map((command) => command.trim())
      .find((command) => command.startsWith("vitest run "))
      ?.split(/\s+/)
      .slice(2);
    expect(focusedTests).toContain("apps/control-worker/test/measurement-ingest.test.ts");
  });

  test("keeps cloud authority, recovery and signed connected publication in the exact V01 target", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    const commands = (manifest.scripts["test:v01"] ?? "")
      .split("&&")
      .map((command) => command.trim());
    const tests = commands
      .find((command) => command.startsWith("vitest run "))
      ?.split(/\s+/)
      .slice(2);
    for (const path of [
      "packages/domain/test/artifact-authority.test.ts",
      "packages/domain/test/artifact-maintenance.test.ts",
      "packages/domain/test/agent-artifacts.test.ts",
      "apps/control-worker/test/artifact-maintenance.test.ts",
      "apps/control-worker/test/agent-artifacts.test.ts",
    ])
      expect(tests).toContain(path);
    expect(commands).toContain("tsx tools/artifacts/run.ts");
    expect(commands).toContain("pnpm exec tsx tools/local-mcp/native.ts v01");
    const native = commands
      .find((command) => command.startsWith("go test -race -count=1 "))
      ?.split(/\s+/)
      .slice(4);
    for (const path of [
      "./internal/agentwork/...",
      "./internal/supervisor/...",
      "./internal/localmcp/...",
      "./internal/runner/...",
      "./internal/daemon/...",
    ])
      expect(native).toContain(path);
  });

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
          workPackage("A03", "in_progress", "pnpm test:a03"),
          workPackage("A04", "in_progress", "pnpm test:a04"),
          workPackage("V01", "in_progress", "pnpm test:v01"),
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
        workPackage("A03", "done", "pnpm test:a03"),
        workPackage("A04", "done", "pnpm test:a04"),
        workPackage("V01", "done", "pnpm test:v01"),
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
      { command: "pnpm", args: ["test:a03"], packages: ["A03"] },
      { command: "pnpm", args: ["test:a04"], packages: ["A04"] },
      { command: "pnpm", args: ["test:v01"], packages: ["V01"] },
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
          workPackage("A03", "done", "pnpm test:a03"),
          workPackage("A04", "done", "pnpm test:a04"),
          workPackage("V01", "done", "pnpm test:v01"),
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
        { command: "pnpm", args: ["test:a03"], packages: ["A03"] },
        { command: "pnpm", args: ["test:a04"], packages: ["A04"] },
        { command: "pnpm", args: ["test:v01"], packages: ["V01"] },
      ]);
    },
  );
});

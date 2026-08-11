// ABOUTME: Selects the exact declared test targets for work packages marked done.
// ABOUTME: Rejects unsupported command shapes so package gates execute without a shell.

import type { WorkPackage } from "./roadmap.js";

export interface PackageGate {
  command: "pnpm";
  args: [string];
  packages: string[];
}

export function packageGates(packages: WorkPackage[]): PackageGate[] {
  const byTarget = new Map<string, string[]>();
  for (const workPackage of packages) {
    if (workPackage.status !== "done") {
      continue;
    }
    const target = workPackage.testTarget;
    if (target === undefined) {
      throw new Error(workPackage.id + " is done without a test target");
    }
    const match = target.match(/^pnpm ([a-z0-9][a-z0-9:_-]*)$/u);
    if (match?.[1] === undefined) {
      throw new Error(workPackage.id + " has unsupported test target: " + target);
    }
    const packageIds = byTarget.get(target) ?? [];
    packageIds.push(workPackage.id);
    byTarget.set(target, packageIds);
  }

  return [...byTarget.entries()].map(([target, packageIds]) => ({
    command: "pnpm",
    args: [target.slice("pnpm ".length)],
    packages: packageIds,
  }));
}

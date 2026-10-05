// ABOUTME: Selects the exact declared test targets for work packages marked done.
// ABOUTME: Runs macOS-only gates solely on darwin and reports them as skipped elsewhere.

import type { WorkPackage } from "./roadmap.js";

export interface PackageGate {
  command: "pnpm";
  args: [string];
  packages: string[];
}

export interface PackageGatePlan {
  run: PackageGate[];
  skipped: PackageGate[];
}

// These targets invoke native harnesses that assert process.platform === "darwin".
// A01/A02 run development-signed daemon/IPC and native ownership proof through
// tools/local-mcp/native.ts. L04/L05 additionally require managed macOS acceptance
// signing/provisioning, and L05 requires an unlocked GUI Terminal session.
// Scheduling skips elsewhere are not acceptance; each target still needs its own
// macOS clean-checkout evidence and the native harness's required local setup.
const darwinOnlyTargets = new Set([
  "pnpm test:a01",
  "pnpm test:a02",
  "pnpm test:l04",
  "pnpm test:l05",
]);

export function planPackageGates(
  packages: WorkPackage[],
  availableScripts: ReadonlySet<string>,
  platform: string = process.platform,
): PackageGatePlan {
  const runnable = new Map<string, string[]>();
  const skipped = new Map<string, string[]>();
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
    if (match[1] === "packages:verify") {
      throw new Error(workPackage.id + " cannot use the package gate runner as its test target");
    }
    if (!availableScripts.has(match[1])) {
      throw new Error(workPackage.id + " test target is not a root package script: " + target);
    }
    const bucket = platform !== "darwin" && darwinOnlyTargets.has(target) ? skipped : runnable;
    const packageIds = bucket.get(target) ?? [];
    packageIds.push(workPackage.id);
    bucket.set(target, packageIds);
  }

  const toGates = (byTarget: Map<string, string[]>): PackageGate[] =>
    [...byTarget.entries()].map(([target, packageIds]) => ({
      command: "pnpm",
      args: [target.slice("pnpm ".length)] as [string],
      packages: packageIds,
    }));
  return { run: toGates(runnable), skipped: toGates(skipped) };
}

// ABOUTME: Runs repository verification plus every done package's declared acceptance target.
// ABOUTME: Requires a clean Git worktree before and after the complete package gate chain.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { runCommand } from "./commands.js";
import { packageGates } from "./package-gates.js";
import { inspectRoadmap } from "./roadmap.js";

const execFileAsync = promisify(execFile);

async function assertCleanWorktree(stage: string): Promise<void> {
  const { stdout } = await execFileAsync("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (stdout.trim().length > 0) {
    throw new Error(stage + " requires a clean worktree:\n" + stdout.trimEnd());
  }
}

const root = process.cwd();
await assertCleanWorktree("Package verification");
await runCommand("pnpm", ["verify"]);

const inspection = await inspectRoadmap(root);
if (inspection.issues.length > 0) {
  throw new Error(
    "Roadmap validation failed:\n" +
      inspection.issues.map((issue) => issue.code + ": " + issue.message).join("\n"),
  );
}

for (const gate of packageGates(inspection.packages)) {
  if (gate.args[0] === "verify") {
    console.log("Package gate " + gate.packages.join(", ") + ": satisfied by pnpm verify");
    continue;
  }
  console.log("Package gate " + gate.packages.join(", ") + ": pnpm " + gate.args[0]);
  await runCommand(gate.command, gate.args);
}

await assertCleanWorktree("Completed package verification");
console.log("Done-package verification: passed");

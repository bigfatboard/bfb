// ABOUTME: Runs repository verification plus every done package's declared acceptance target.
// ABOUTME: Requires a clean Git worktree before and after the complete package gate chain.

import { readFile } from "node:fs/promises";

import { runCommand } from "./commands.js";
import { packageGates } from "./package-gates.js";
import { inspectRoadmap } from "./roadmap.js";
import { assertCleanWorktree } from "./worktree.js";

const root = process.cwd();
await assertCleanWorktree(root, "Package verification");
await runCommand("pnpm", ["verify"]);

const inspection = await inspectRoadmap(root);
if (inspection.issues.length > 0) {
  throw new Error(
    "Roadmap validation failed:\n" +
      inspection.issues.map((issue) => issue.code + ": " + issue.message).join("\n"),
  );
}

const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
  scripts?: Record<string, unknown>;
};
const availableScripts = new Set(Object.keys(packageJson.scripts ?? {}));
for (const gate of packageGates(inspection.packages, availableScripts)) {
  if (gate.args[0] === "verify") {
    console.log("Package gate " + gate.packages.join(", ") + ": satisfied by pnpm verify");
    continue;
  }
  console.log("Package gate " + gate.packages.join(", ") + ": pnpm " + gate.args[0]);
  await runCommand(gate.command, gate.args);
}

await assertCleanWorktree(root, "Completed package verification");
console.log("Done-package verification: passed");

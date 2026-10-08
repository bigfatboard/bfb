// ABOUTME: Orchestrates the stable, platform-aware BFB repository verification gate.
// ABOUTME: Checks pinned tools and streams every delegated check without suppressing output.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { runCommand } from "./commands.js";

const execFileAsync = promisify(execFile);
const expectedNode = "v" + (await readFile(".node-version", "utf8")).trim();
if (process.version !== expectedNode) {
  throw new Error(
    "Node version mismatch: expected " + expectedNode + ", received " + process.version,
  );
}
const expectedPnpm = "11.21.0";
const { stdout: actualPnpm } = await execFileAsync("pnpm", ["--version"]);
if (actualPnpm.trim() !== expectedPnpm) {
  throw new Error(
    "pnpm version mismatch: expected " + expectedPnpm + ", received " + actualPnpm.trim(),
  );
}

const checks: Array<[string, string[]]> = [
  ["pnpm", ["install", "--lockfile-only", "--offline", "--frozen-lockfile", "--ignore-scripts"]],
  ["pnpm", ["format:check"]],
  ["pnpm", ["lint"]],
  ["pnpm", ["typecheck"]],
  ["pnpm", ["protocol:check"]],
  ["pnpm", ["provider:check"]],
  ["pnpm", ["test"]],
  ["pnpm", ["headers:check"]],
  ["pnpm", ["docs:check"]],
  ["pnpm", ["roadmap:check"]],
  ["pnpm", ["go:check"]],
  ["pnpm", ["swift:check"]],
];

for (const [command, args] of checks) {
  await runCommand(command, args);
}
console.log("Repository verification: passed");

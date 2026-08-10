// ABOUTME: Runs the pinned Go formatting, dependency, analysis, test, and build gates.
// ABOUTME: Reports formatting drift without rewriting source files during verification.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { runCommand } from "./commands.js";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const expectedVersion = "go" + (await readFile(".go-version", "utf8")).trim();
const { stdout: actualVersion } = await execFileAsync("go", ["env", "GOVERSION"], { cwd: root });
if (actualVersion.trim() !== expectedVersion) {
  throw new Error(
    "Go version mismatch: expected " + expectedVersion + ", received " + actualVersion.trim(),
  );
}

const { stdout: unformattedFiles } = await execFileAsync("gofmt", ["-l", "."], { cwd: root });
if (unformattedFiles.trim().length > 0) {
  throw new Error("gofmt required for:\n" + unformattedFiles.trim());
}

await runCommand("go", ["mod", "tidy", "-diff"], { cwd: root });
await runCommand("go", ["vet", "./..."], { cwd: root });
await runCommand("go", ["test", "./..."], { cwd: root });
await runCommand("go", ["build", "./..."], { cwd: root });
console.log("Go checks: passed (" + expectedVersion + ")");

// ABOUTME: Exercises clean, modified, and untracked Git worktree verification states.
// ABOUTME: Proves the package gate reports paths that would invalidate clean-checkout evidence.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { assertCleanWorktree } from "../src/worktree.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function cleanRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bfb-worktree-"));
  temporaryRoots.push(root);
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "tests@bfb.invalid"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "BFB Tests"], { cwd: root });
  await writeFile(path.join(root, "tracked.txt"), "clean\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("clean worktree assertion", () => {
  test("accepts a clean repository", async () => {
    const root = await cleanRepository();

    await expect(assertCleanWorktree(root, "test")).resolves.toBeUndefined();
  });

  test("reports modified and untracked paths", async () => {
    const root = await cleanRepository();
    await writeFile(path.join(root, "tracked.txt"), "modified\n");
    await writeFile(path.join(root, "untracked.txt"), "untracked\n");

    await expect(assertCleanWorktree(root, "test")).rejects.toThrow("tracked.txt");
    await expect(assertCleanWorktree(root, "test")).rejects.toThrow("untracked.txt");
  });
});

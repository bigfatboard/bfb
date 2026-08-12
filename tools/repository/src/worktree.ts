// ABOUTME: Verifies that package gates start and finish with a clean Git worktree.
// ABOUTME: Reports every tracked or unexpected untracked path without suppressing details.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function assertCleanWorktree(root: string, stage: string): Promise<void> {
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: root },
  );
  if (stdout.trim().length > 0) {
    throw new Error(stage + " requires a clean worktree:\n" + stdout.trimEnd());
  }
}

// ABOUTME: Exposes the repository clean-worktree assertion as a CI command.
// ABOUTME: Fails with the complete changed-path list when verification leaves output behind.

import { assertCleanWorktree } from "./worktree.js";

await assertCleanWorktree(process.cwd(), "Worktree check");
console.log("Worktree check: passed");

// ABOUTME: Exposes deterministic work-package validation and generation at the root CLI.
// ABOUTME: Refuses to rewrite roadmap output while metadata or dependency errors exist.

import { inspectRoadmap, writeGeneratedRoadmap } from "./roadmap.js";

const mode = process.argv[2] ?? "check";
if (mode !== "check" && mode !== "write") {
  console.error("usage: pnpm roadmap:check | pnpm roadmap:write");
  process.exitCode = 2;
} else {
  const inspection =
    mode === "write"
      ? await writeGeneratedRoadmap(process.cwd())
      : await inspectRoadmap(process.cwd());
  if (inspection.issues.length > 0) {
    for (const issue of inspection.issues) {
      console.error(issue.code + ": " + issue.message);
    }
    process.exitCode = 1;
  } else {
    console.log(
      "Work-package roadmap: passed (" +
        inspection.packages.length +
        " packages, mode " +
        mode +
        ")",
    );
  }
}

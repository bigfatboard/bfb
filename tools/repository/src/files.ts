// ABOUTME: Provides deterministic repository file discovery for policy checks.
// ABOUTME: Excludes build products and dependency directories shared by all validators.

import { readdir } from "node:fs/promises";
import path from "node:path";

const excludedDirectoryNames = new Set([
  ".git",
  ".pnpm-store",
  ".wrangler",
  "DerivedData",
  "coverage",
  "dist",
  "node_modules",
  "xcuserdata",
]);

export async function walkFiles(
  root: string,
  include: (relativePath: string) => boolean,
): Promise<string[]> {
  const matches: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");

      if (entry.isDirectory()) {
        if (!excludedDirectoryNames.has(entry.name)) {
          await visit(absolutePath);
        }
        continue;
      }

      if (entry.isFile() && include(relativePath)) {
        matches.push(relativePath);
      }
    }
  }

  await visit(root);
  return matches;
}

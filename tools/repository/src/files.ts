// ABOUTME: Provides deterministic repository file discovery for policy checks.
// ABOUTME: Excludes build products and dependency directories shared by all validators.

import { readdir, realpath } from "node:fs/promises";
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

export function resolveRepositoryPath(root: string, repositoryPath: string): string | undefined {
  if (repositoryPath.length === 0 || path.isAbsolute(repositoryPath)) {
    return undefined;
  }
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, repositoryPath);
  const relativePath = path.relative(resolvedRoot, resolvedPath);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(".." + path.sep) ||
    path.isAbsolute(relativePath)
  ) {
    return undefined;
  }
  return resolvedPath;
}

export async function resolveExistingRepositoryPath(
  root: string,
  repositoryPath: string,
): Promise<string | undefined> {
  const resolvedPath = resolveRepositoryPath(root, repositoryPath);
  if (resolvedPath === undefined) {
    return undefined;
  }
  try {
    const [realRoot, realPath] = await Promise.all([realpath(root), realpath(resolvedPath)]);
    const relativePath = path.relative(realRoot, realPath);
    if (
      relativePath.length === 0 ||
      relativePath === ".." ||
      relativePath.startsWith(".." + path.sep) ||
      path.isAbsolute(relativePath)
    ) {
      return undefined;
    }
    return resolvedPath;
  } catch {
    return undefined;
  }
}

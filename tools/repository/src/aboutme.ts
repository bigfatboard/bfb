// ABOUTME: Enforces the two-line ABOUTME header contract on hand-written source files.
// ABOUTME: Keeps generated protocol output and synthetic fixtures outside that policy.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { walkFiles } from "./files.js";

const lineRules = new Map<string, { prefix: string; suffix?: string }>([
  [".cjs", { prefix: "// ABOUTME: " }],
  [".css", { prefix: "/* ABOUTME: ", suffix: " */" }],
  [".go", { prefix: "// ABOUTME: " }],
  [".html", { prefix: "<!-- ABOUTME: ", suffix: " -->" }],
  [".js", { prefix: "// ABOUTME: " }],
  [".jsx", { prefix: "// ABOUTME: " }],
  [".mjs", { prefix: "// ABOUTME: " }],
  [".sql", { prefix: "-- ABOUTME: " }],
  [".swift", { prefix: "// ABOUTME: " }],
  [".ts", { prefix: "// ABOUTME: " }],
  [".tsx", { prefix: "// ABOUTME: " }],
]);

const exemptPathPrefixes = [
  "packages/protocol-ts/src/generated/",
  "internal/protocol/generated/",
  "protocol/fixtures/",
];

export async function validateAboutmeHeaders(root: string): Promise<string[]> {
  const sourceFiles = await walkFiles(root, (relativePath) => {
    if (exemptPathPrefixes.some((prefix) => relativePath.startsWith(prefix))) {
      return false;
    }
    return lineRules.has(path.extname(relativePath));
  });
  const failures: string[] = [];

  for (const relativePath of sourceFiles) {
    const rule = lineRules.get(path.extname(relativePath));
    if (rule === undefined) {
      continue;
    }

    const source = await readFile(path.join(root, relativePath), "utf8");
    const lines = source.split(/\r?\n/u);
    for (const lineNumber of [0, 1]) {
      const line = lines[lineNumber] ?? "";
      const hasPrefix = line.startsWith(rule.prefix);
      const hasSuffix = rule.suffix === undefined || line.endsWith(rule.suffix);
      const end = rule.suffix === undefined ? undefined : -rule.suffix.length;
      const hasText = line.slice(rule.prefix.length, end).trim().length > 0;

      if (!hasPrefix || !hasSuffix || !hasText) {
        failures.push(
          relativePath +
            ":" +
            (lineNumber + 1) +
            " must be a non-empty " +
            rule.prefix.trim() +
            " header line",
        );
      }
    }
  }

  return failures;
}

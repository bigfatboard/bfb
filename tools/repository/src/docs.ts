// ABOUTME: Validates repository-relative links in committed Markdown documents.
// ABOUTME: Ignores external destinations and examples inside fenced code blocks.

import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { walkFiles } from "./files.js";

export interface LinkFailure {
  document: string;
  line: number;
  target: string;
}

function markdownWithoutFencedCode(source: string): string[] {
  const output: string[] = [];
  let fence: string | undefined;

  for (const line of source.split(/\r?\n/u)) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/u);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1];
      if (fence === undefined) {
        fence = marker?.[0];
      } else if (marker?.[0] === fence) {
        fence = undefined;
      }
      output.push("");
      continue;
    }
    output.push(fence === undefined ? line : "");
  }

  return output;
}

function localTarget(rawTarget: string): string | undefined {
  const trimmed = rawTarget.trim();
  const target =
    trimmed.startsWith("<") && trimmed.includes(">")
      ? trimmed.slice(1, trimmed.indexOf(">"))
      : (trimmed.match(/^\S+/u)?.[0] ?? "");

  if (
    target.length === 0 ||
    target.startsWith("#") ||
    /^(?:https?:|mailto:|data:)/iu.test(target)
  ) {
    return undefined;
  }

  return target.split(/[?#]/u)[0];
}

export async function validateMarkdownLinks(root: string): Promise<LinkFailure[]> {
  const documents = await walkFiles(root, (relativePath) => relativePath.endsWith(".md"));
  const failures: LinkFailure[] = [];

  for (const document of documents) {
    const source = await readFile(path.join(root, document), "utf8");
    const lines = markdownWithoutFencedCode(source);

    for (const [lineIndex, line] of lines.entries()) {
      const links = line.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu);
      for (const link of links) {
        const target = localTarget(link[1] ?? "");
        if (target === undefined) {
          continue;
        }

        let decodedTarget: string;
        try {
          decodedTarget = decodeURIComponent(target);
        } catch {
          failures.push({ document, line: lineIndex + 1, target });
          continue;
        }

        const absoluteTarget = path.isAbsolute(decodedTarget)
          ? decodedTarget
          : path.resolve(root, path.dirname(document), decodedTarget);
        try {
          await access(absoluteTarget);
        } catch {
          failures.push({ document, line: lineIndex + 1, target });
        }
      }
    }
  }

  return failures;
}

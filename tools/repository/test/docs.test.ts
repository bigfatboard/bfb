// ABOUTME: Exercises valid, missing, encoded, and fenced Markdown link cases.
// ABOUTME: Keeps documentation link failures reproducible without network access.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { validateMarkdownLinks } from "../src/docs.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bfb-docs-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("validateMarkdownLinks", () => {
  test("accepts existing encoded paths and external links", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", "target file.md"), "# Target\n");
    await writeFile(
      path.join(root, "README.md"),
      "[Target](docs/target%20file.md#section) [External](https://example.com)\n",
    );

    await expect(validateMarkdownLinks(root)).resolves.toEqual([]);
  });

  test("reports a missing local target", async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, "README.md"), "[Missing](docs/missing.md)\n");

    await expect(validateMarkdownLinks(root)).resolves.toEqual([
      { document: "README.md", line: 1, target: "docs/missing.md" },
    ]);
  });

  test("ignores links shown inside fenced examples", async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, "README.md"), "```md\n[Example](missing.md)\n```\n");

    await expect(validateMarkdownLinks(root)).resolves.toEqual([]);
  });
});

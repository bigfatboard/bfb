// ABOUTME: Exercises valid, missing, encoded, and fenced Markdown link cases.
// ABOUTME: Keeps documentation link failures reproducible without network access.

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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

  test("rejects an absolute target even when it exists", async () => {
    const root = await temporaryRoot();
    const target = path.join(root, "target.md");
    await writeFile(target, "# Target\n");
    await writeFile(path.join(root, "README.md"), "[Absolute](/target.md)\n");

    await expect(validateMarkdownLinks(root)).resolves.toEqual([
      { document: "README.md", line: 1, target: "/target.md" },
    ]);
  });

  test("rejects a parent traversal even when its target exists", async () => {
    const root = await temporaryRoot();
    const target = root + "-outside.md";
    temporaryRoots.push(target);
    await writeFile(target, "# Outside\n");
    const relativeTarget = "../" + path.basename(target);
    await writeFile(path.join(root, "README.md"), "[Outside](" + relativeTarget + ")\n");

    await expect(validateMarkdownLinks(root)).resolves.toEqual([
      { document: "README.md", line: 1, target: relativeTarget },
    ]);
  });

  test("rejects an in-repository symlink to an external target", async () => {
    const root = await temporaryRoot();
    const target = root + "-outside.md";
    temporaryRoots.push(target);
    await writeFile(target, "# Outside\n");
    await symlink(target, path.join(root, "linked.md"));
    await writeFile(path.join(root, "README.md"), "[Linked](linked.md)\n");

    await expect(validateMarkdownLinks(root)).resolves.toEqual([
      { document: "README.md", line: 1, target: "linked.md" },
    ]);
  });

  test("ignores links shown inside fenced examples", async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, "README.md"), "```md\n[Example](missing.md)\n```\n");

    await expect(validateMarkdownLinks(root)).resolves.toEqual([]);
  });
});

// ABOUTME: Exercises valid, invalid, and generated-source ABOUTME header cases.
// ABOUTME: Keeps the source-header policy failure modes executable.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { validateAboutmeHeaders } from "../src/aboutme.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bfb-aboutme-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("validateAboutmeHeaders", () => {
  test("accepts two descriptive header lines", async () => {
    const root = await temporaryRoot();
    await writeFile(
      path.join(root, "valid.ts"),
      "// ABOUTME: Describes this source.\n// ABOUTME: Describes its boundary.\nexport {};\n",
    );

    await expect(validateAboutmeHeaders(root)).resolves.toEqual([]);
  });

  test("reports a missing second header", async () => {
    const root = await temporaryRoot();
    await writeFile(
      path.join(root, "invalid.go"),
      "// ABOUTME: Describes this source.\npackage invalid\n",
    );

    await expect(validateAboutmeHeaders(root)).resolves.toEqual([
      "invalid.go:2 must be a non-empty // ABOUTME: header line",
    ]);
  });

  test("does not inspect generated protocol output", async () => {
    const root = await temporaryRoot();
    const generatedDirectory = path.join(root, "packages/protocol-ts/src/generated");
    await mkdir(generatedDirectory, { recursive: true });
    await writeFile(path.join(generatedDirectory, "wire.ts"), "export {};\n");

    await expect(validateAboutmeHeaders(root)).resolves.toEqual([]);
  });
});

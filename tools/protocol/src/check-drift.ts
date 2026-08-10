// ABOUTME: Fails when generated wire types differ from the current protocol schemas.
// ABOUTME: Regenerates into a temp tree and compares against checked-in outputs.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cp } from "node:fs/promises";

import { generateProtocol } from "./generate.js";

async function read(root: string, relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}

export async function checkProtocolDrift(root: string): Promise<string[]> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "bfb-protocol-drift-"));
  try {
    // Copy only what the generator needs
    await cp(path.join(root, "protocol"), path.join(tempRoot, "protocol"), { recursive: true });
    await cp(path.join(root, "tools/protocol"), path.join(tempRoot, "tools/protocol"), {
      recursive: true,
    });
    await mkdirp(path.join(tempRoot, "packages/protocol-ts/src"));
    await mkdirp(path.join(tempRoot, "internal/protocol"));
    await generateProtocol(tempRoot, { formatCwd: root });

    const paths = [
      "packages/protocol-ts/src/generated/types.ts",
      "packages/protocol-ts/src/generated/catalog.json",
      "internal/protocol/generated/types.go",
    ];
    const issues: string[] = [];
    for (const relativePath of paths) {
      const expected = await read(tempRoot, relativePath);
      const actual = await read(root, relativePath);
      if (expected !== actual) {
        issues.push(relativePath + " is out of date with protocol/schema");
      }
    }
    return issues;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function mkdirp(dir: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
}

const isMain =
  process.argv[1]?.endsWith("check-drift.ts") || process.argv[1]?.endsWith("check-drift.js");
if (isMain) {
  const issues = await checkProtocolDrift(process.cwd());
  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(issue);
    }
    process.exitCode = 1;
  } else {
    console.log("protocol drift: passed");
  }
}

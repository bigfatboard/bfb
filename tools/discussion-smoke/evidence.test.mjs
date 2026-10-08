// ABOUTME: Locks the D03 evidence manifest to repository-relative artifact paths.
// ABOUTME: Fails when a listed artifact does not resolve from the repository root.

import assert from "node:assert/strict";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const toolDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(toolDir, "../..");
const manifestPath = resolve(root, "docs/work-packages/evidence/WP-D03/manifest.json");

async function assertRepositoryFile(candidate) {
  assert.equal(typeof candidate, "string", "evidence artifact must be a string");
  assert.ok(candidate.length > 0, "evidence artifact must not be empty");
  assert.ok(!/\s/u.test(candidate), `artifact must not contain whitespace: ${candidate}`);
  assert.ok(!candidate.includes(".."), `artifact must not escape the repository: ${candidate}`);
  assert.ok(!isAbsolute(candidate), `artifact must be repository-relative: ${candidate}`);
  const resolved = resolve(root, candidate);
  const [realRoot, realResolved] = await Promise.all([realpath(root), realpath(resolved)]);
  const outward = relative(realRoot, realResolved);
  assert.ok(
    outward.length > 0 && outward !== ".." && !outward.startsWith(`..${"/"}`),
    `artifact is missing or outside the repository: ${candidate}`,
  );
  assert.ok((await stat(resolved)).isFile(), `artifact is not a file: ${candidate}`);
}

test("D03 manifest lists repository-relative artifacts that exist", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.package, "D03");
  assert.ok(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0);
  const referenced = [
    ...manifest.artifacts,
    ...manifest.commands.flatMap((command) =>
      command.artifact === undefined ? [] : [command.artifact],
    ),
  ];
  assert.equal(
    new Set(manifest.artifacts).size,
    manifest.artifacts.length,
    "artifacts must be unique",
  );
  for (const artifact of new Set(referenced)) {
    await assertRepositoryFile(artifact);
  }
});

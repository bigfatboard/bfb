// ABOUTME: Locks each G01 gate row to the owning package proof it certifies.
// ABOUTME: Fails when a passed row cites pnpm test:g01 instead of its proof owner.

import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GATE_ROWS, G01_COMMAND, G01_GATE_EVIDENCE } from "./gates.ts";

const toolDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(toolDir, "../..");

const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const scripts = new Set(Object.keys(packageJson.scripts ?? {}));

test("gate table covers every release gate exactly once", () => {
  const expected = [
    "AG-01",
    "AG-02",
    "AG-03",
    "AG-04",
    "AG-05",
    "AG-06",
    "AG-07",
    "AG-08",
    "AG-09",
    "AG-10",
    "SG-01",
    "SG-02",
    "SG-03",
    "SG-04",
    "SG-05",
    "OG-01",
    "OG-02",
  ];
  assert.deepEqual(GATE_ROWS.map((row) => row.gate).sort(), [...expected].sort());
});

for (const row of GATE_ROWS) {
  test(`${row.gate} cites a reproducible command that locates its proof`, async () => {
    for (const part of row.command.split("&&").map((chunk) => chunk.trim())) {
      assert.match(part, /^pnpm \S+$/, `${row.gate} command must be a pnpm script reference`);
      const name = part.replace(/^pnpm\s+/, "");
      assert.ok(scripts.has(name), `${row.gate} command ${part} must be a root package script`);
    }
    await stat(resolve(root, row.evidence));
    if (row.owner === "G01") {
      assert.equal(row.command, G01_COMMAND, `${row.gate} is G01-owned proof`);
      assert.equal(row.evidence, G01_GATE_EVIDENCE, `${row.gate} is G01-owned evidence`);
      return;
    }
    const manifestPath = `docs/work-packages/evidence/WP-${row.owner}/manifest.json`;
    assert.equal(
      row.evidence,
      manifestPath,
      `${row.gate} must locate its proof in the owning ${row.owner} manifest, not the G01 report`,
    );
    const manifest = JSON.parse(await readFile(resolve(root, manifestPath), "utf8"));
    assert.equal(manifest.outcome, "passed", `${manifestPath} must record a passed run`);
    const recorded = (manifest.commands ?? []).map((entry) => entry.command);
    assert.ok(
      recorded.includes(row.command),
      `${row.gate} command ${row.command} must be recorded in ${manifestPath}`,
    );
  });
}

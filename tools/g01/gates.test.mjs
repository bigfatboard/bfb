// ABOUTME: Locks each G01 gate row to the owning package proof it certifies.
// ABOUTME: Fails when a passed row cites the wrong proof or a waived row lacks an ADR decision.

import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GATE_ROWS, G01_COMMAND, G01_GATE_EVIDENCE, waiverDefect } from "./gates.ts";

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

test("waived gates cite an ADR recording Timo's explicit decision", async () => {
  const adrIndex = new Map();
  for (const entry of await readdir(resolve(root, "docs/adr"))) {
    if (!entry.endsWith(".md")) continue;
    adrIndex.set(
      `docs/adr/${entry}`,
      await readFile(resolve(root, "docs/adr", entry), "utf8"),
    );
  }
  for (const row of GATE_ROWS) {
    assert.equal(
      waiverDefect(row, adrIndex),
      null,
      `${row.gate} carries an unauthorized waiver`,
    );
  }
});

test("waiverDefect rejects self-issued waivers and accepts authorized ones", () => {
  const authorized = new Map([
    [
      "docs/adr/0004-provider-turn-waiver.md",
      "# ADR 0004\nGate AG-04 is deferred.\nTimo's decision: waive pending credentials.",
    ],
  ]);
  const base = {
    gate: "AG-04",
    owner: "G01",
    command: "pnpm test:g01",
    evidence: "docs/work-packages/evidence/WP-G01/gate-report.json",
    detail: "detail",
  };
  assert.match(
    waiverDefect(
      { ...base, status: "waived", waiver: "blocked on credentials" },
      authorized,
    ) ?? "",
    /no docs\/adr decision record/,
  );
  assert.match(
    waiverDefect(
      { ...base, status: "waived", waiver: "see docs/adr/0099-missing.md" },
      authorized,
    ) ?? "",
    /not a recorded ADR/,
  );
  assert.match(
    waiverDefect(
      { ...base, status: "waived", waiver: "see docs/adr/0004-provider-turn-waiver.md" },
      new Map([["docs/adr/0004-provider-turn-waiver.md", "# ADR 0004\nNo gate named."]]),
    ) ?? "",
    /does not decide AG-04/,
  );
  assert.match(
    waiverDefect(
      { ...base, status: "waived", waiver: "see docs/adr/0004-provider-turn-waiver.md" },
      new Map([["docs/adr/0004-provider-turn-waiver.md", "# ADR 0004\nGate AG-04 deferred."]]),
    ) ?? "",
    /no explicit Timo decision/,
  );
  assert.equal(
    waiverDefect(
      { ...base, status: "waived", waiver: "see docs/adr/0004-provider-turn-waiver.md" },
      authorized,
    ),
    null,
  );
  assert.equal(waiverDefect({ ...base, status: "passed" }, authorized), null);
  assert.equal(
    waiverDefect(
      { ...base, status: "not_run", waiver: "G02 owns this gate." },
      authorized,
    ),
    null,
  );
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

// ABOUTME: Locks each G01 gate row to the owning package proof it certifies.
// ABOUTME: Fails when a passed row cites the wrong proof, cites flaky proof, or a waived row lacks an ADR decision.

import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  GATE_ROWS,
  G01_COMMAND,
  G01_GATE_EVIDENCE,
  flakyProofDefect,
  waiverDefect,
} from "./gates.ts";
import { burstWriteDelta, summarizeBurstLatencies } from "./perf.ts";

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
    adrIndex.set(`docs/adr/${entry}`, await readFile(resolve(root, "docs/adr", entry), "utf8"));
  }
  for (const row of GATE_ROWS) {
    assert.equal(waiverDefect(row, adrIndex), null, `${row.gate} carries an unauthorized waiver`);
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
    waiverDefect({ ...base, status: "waived", waiver: "blocked on credentials" }, authorized) ?? "",
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
    waiverDefect({ ...base, status: "not_run", waiver: "G02 owns this gate." }, authorized),
    null,
  );
});

test("flakyProofDefect rejects passed rows citing proof with a failed run", () => {
  const row = {
    gate: "AG-02",
    owner: "L05",
    status: "passed",
    command: "pnpm test:l05",
    evidence: "docs/work-packages/evidence/WP-L05/manifest.json",
    detail: "detail",
  };
  const flakyRuns = [
    {
      gate_runs: {
        implementation_checkout: ["passed", "passed", "passed"],
        clean_checkout: ["failed", "passed"],
      },
    },
  ];
  assert.match(flakyProofDefect(row, flakyRuns) ?? "", /records a failed run/);
  assert.match(
    flakyProofDefect(row, [{ runs: [{ command: "pnpm test:x", outcome: "failed" }] }]) ?? "",
    /records a failed run/,
  );
  assert.equal(
    flakyProofDefect(row, [{ gate_runs: { clean_checkout: ["passed", "passed"] } }]),
    null,
  );
  assert.equal(
    flakyProofDefect(row, [{ runs: [{ command: "pnpm test:x", outcome: "passed" }] }]),
    null,
  );
  assert.equal(flakyProofDefect(row, [{ notes: ["one failed attempt retried"] }]), null);
  assert.equal(flakyProofDefect({ ...row, status: "failed" }, flakyRuns), null);
  assert.equal(flakyProofDefect({ ...row, status: "not_run" }, flakyRuns), null);
  assert.equal(
    flakyProofDefect(
      {
        ...row,
        owner: "G01",
        command: "pnpm test:g01",
        evidence: "docs/work-packages/evidence/WP-G01/gate-report.json",
      },
      flakyRuns,
    ),
    null,
  );
});

test("passed rows cite proof with no failed runs recorded", async () => {
  for (const row of GATE_ROWS) {
    if (row.status !== "passed" || row.owner === "G01") {
      continue;
    }
    const manifest = JSON.parse(await readFile(resolve(root, row.evidence), "utf8"));
    const linked = [];
    for (const entry of manifest.commands ?? []) {
      if (typeof entry.artifact !== "string" || !entry.artifact.endsWith(".json")) {
        continue;
      }
      linked.push(JSON.parse(await readFile(resolve(root, entry.artifact), "utf8")));
    }
    assert.equal(flakyProofDefect(row, linked), null, `${row.gate} cites flaky proof`);
  }
});

test("golden fixture evidence advertises the two-workspace envelope the harness builds", async () => {
  const fixture = JSON.parse(
    await readFile(resolve(root, "docs/work-packages/evidence/WP-G01/fixture.json"), "utf8"),
  );
  assert.deepEqual(
    fixture.workspaces,
    ["primary", "second-tenant"],
    "fixture.json must record the primary workspace and the second tenant",
  );
  assert.deepEqual(
    fixture.second_tenant,
    { humans: ["owner"], projects: ["second"], tasks: 1 },
    "fixture.json must record the second tenant the cross-workspace probes run against",
  );
});

test("every declared redaction canary is planted in a scenario, not only listed", async () => {
  const runSource = await readFile(resolve(root, "tools/g01/run.ts"), "utf8");
  const block = runSource.match(/const CANARIES = \{([^}]*)\}/s)?.[1];
  assert.ok(block, "run.ts declares its planted CANARIES block");
  const keys = [...block.matchAll(/^\s*(\w+):/gm)].map((match) => match[1]);
  assert.ok(keys.length >= 8, "the canary block covers every prohibited class");
  // The scanner derives its needles from the same block, so a planted class
  // is always a scanned class.
  assert.match(
    runSource,
    /const NEEDLES = Object\.values\(CANARIES\)/,
    "NEEDLES derives from CANARIES",
  );
  for (const key of keys) {
    const uses = runSource.match(new RegExp(`CANARIES\\.${key}\\b`, "g")) ?? [];
    assert.ok(
      uses.length >= 1,
      `CANARIES.${key} must be planted in a scenario (found only in its declaration)`,
    );
  }
  const report = JSON.parse(
    await readFile(resolve(root, "docs/work-packages/evidence/WP-G01/redaction-scan.json"), "utf8"),
  );
  assert.equal(report.hits, 0, "the committed scan records zero hits");
  assert.ok(
    Array.isArray(report.needle_classes) && report.needle_classes.length >= keys.length,
    "the committed scan lists every planted canary class",
  );
});

test("performance baseline records launched concurrent runs, not unlaunched tasks", async () => {
  const baseline = JSON.parse(
    await readFile(resolve(root, "docs/work-packages/evidence/WP-G01/perf-baseline.json"), "utf8"),
  );
  assert.ok(
    !("concurrent_envelope_tasks" in (baseline.envelope ?? {})),
    "envelope must not count tasks that never run as concurrent",
  );
  assert.equal(baseline.envelope.envelope_tasks, 10, "ten envelope tasks stay open");
  assert.ok(
    Number.isInteger(baseline.envelope.concurrent_runs) && baseline.envelope.concurrent_runs >= 2,
    "envelope must record the concurrently claimed runs across both runners",
  );
  assert.equal(
    baseline.measured.concurrent_runs_claimed,
    baseline.envelope.concurrent_runs,
    "every concurrently started run must reach claimed",
  );
});

test("burst summary derives its verdict from the measured elapsed, not a literal", () => {
  const fast = summarizeBurstLatencies(Array(50).fill(12), 900, 120_000);
  assert.equal(fast.elapsed_ms, 900, "summary records the measured elapsed");
  assert.equal(fast.within_bound, true, "a fast burst stays within its bound");
  assert.equal(fast.latency_max_ms, 12, "summary reflects the sampled latencies");
  assert.equal(fast.throughput_per_s, 55.56, "throughput derives from commands over elapsed");
  // The finding's failure mode: a 100x slowdown must change the record.
  const slow = summarizeBurstLatencies(Array(50).fill(2400), 125_000, 120_000);
  assert.equal(slow.within_bound, false, "a slowed burst flips the computed verdict");
  assert.equal(slow.latency_p50_ms, 2400, "the slowdown is visible in the latency figures");
  assert.ok(
    slow.elapsed_ms !== fast.elapsed_ms,
    "slow and fast bursts never share one constant record",
  );
});

test("burst summary reports honest latency distribution figures", () => {
  const summary = summarizeBurstLatencies([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 500, 120_000);
  assert.equal(summary.latency_min_ms, 1, "min is the fastest sample");
  assert.equal(summary.latency_p50_ms, 5, "p50 is the nearest-rank median");
  assert.equal(summary.latency_mean_ms, 5.5, "mean covers every sample");
  assert.equal(summary.latency_p95_ms, 10, "p95 exposes the slowest commands");
  assert.equal(summary.latency_max_ms, 10, "max is the slowest sample");
  assert.throws(
    () => summarizeBurstLatencies([], 500, 120_000),
    /at least one measured command latency/,
    "an unmeasured burst cannot produce a baseline",
  );
});

test("burst write delta measures the rows one burst wrote", () => {
  const writes = burstWriteDelta(
    { tasks: 33, ledger_events: 8, semantic_events: 100 },
    { tasks: 83, ledger_events: 8, semantic_events: 158 },
  );
  assert.deepEqual(
    writes,
    { tasks_written: 50, ledger_events_written: 0, semantic_events_written: 58 },
    "deltas measure rows written between the two counter reads",
  );
  assert.throws(
    () =>
      burstWriteDelta(
        { tasks: 83, ledger_events: 8, semantic_events: 158 },
        { tasks: 33, ledger_events: 8, semantic_events: 158 },
      ),
    /non-negative row delta/,
    "vanishing rows fail closed instead of recording a negative resource figure",
  );
});

test("performance baseline records measured figures with a computed bound verdict", async () => {
  const baseline = JSON.parse(
    await readFile(resolve(root, "docs/work-packages/evidence/WP-G01/perf-baseline.json"), "utf8"),
  );
  const measured = baseline.measured;
  assert.ok(
    Number.isInteger(measured.hub_burst_elapsed_ms) && measured.hub_burst_elapsed_ms > 0,
    "baseline must record the measured burst elapsed",
  );
  assert.ok(
    measured.hub_burst_elapsed_ms < measured.hub_burst_bound_ms,
    "recorded elapsed must clear the recorded bound on a passing baseline",
  );
  assert.equal(
    measured.hub_burst_within_bound,
    measured.hub_burst_elapsed_ms < measured.hub_burst_bound_ms,
    "the bound verdict must be computed from the measured elapsed, never a literal",
  );
  const latency = measured.hub_burst_latency_ms;
  for (const key of ["min", "p50", "mean", "p95", "max"]) {
    assert.ok(
      typeof latency[key] === "number" && latency[key] >= 0,
      `latency ${key} must be a measured non-negative figure`,
    );
  }
  assert.ok(
    latency.min <= latency.p50 && latency.p50 <= latency.p95 && latency.p95 <= latency.max,
    "latency figures must order min <= p50 <= p95 <= max",
  );
  assert.ok(
    latency.max <= measured.hub_burst_elapsed_ms,
    "no single command outlasts the burst that contains it",
  );
  assert.ok(
    latency.mean >= latency.min && latency.mean <= latency.max,
    "mean must lie within the sampled range",
  );
  const expectedThroughput = (measured.hub_burst_commands / measured.hub_burst_elapsed_ms) * 1000;
  assert.ok(
    Math.abs(measured.hub_burst_throughput_per_s - expectedThroughput) < 0.05,
    "throughput must derive from commands over measured elapsed",
  );
  assert.equal(
    measured.hub_burst_writes.tasks_written,
    measured.hub_burst_committed,
    "every committed burst command must account for one written task row",
  );
  for (const key of ["tasks_written", "ledger_events_written", "semantic_events_written"]) {
    assert.ok(
      Number.isInteger(measured.hub_burst_writes[key]) && measured.hub_burst_writes[key] >= 0,
      `write amplification ${key} must be a measured non-negative row count`,
    );
  }
  assert.equal(
    baseline.outcome,
    measured.hub_burst_within_bound ? "passed" : "failed",
    "baseline outcome must follow the computed bound verdict",
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

// ABOUTME: Locks work-package files to the template Evidence/Handoff structure.
// ABOUTME: Fails on combined headings, header status duplicates, mechanics prose, and progress-log disorder.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const packagesDir = path.join(root, "docs", "work-packages");
const progressPath = path.join(root, "mvp.progress.md");

async function packageFiles(): Promise<string[]> {
  const entries = await readdir(packagesDir);
  return entries.filter((entry) => entry.startsWith("WP-") && entry.endsWith(".md")).sort();
}

const MONTHS = new Map(
  [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ].map((name, index) => [name, index + 1]),
);

function datedKey(line: string): number | undefined {
  const match = /(\d{1,2}) ([A-Z][a-z]+)/.exec(line);
  if (match === null) {
    return undefined;
  }
  const month = MONTHS.get(match[2] ?? "");
  if (month === undefined) {
    return undefined;
  }
  return month * 100 + Number(match[1]);
}

describe("work-package document structure", () => {
  test("uses separate template Evidence and Handoff sections", async () => {
    const failures: string[] = [];
    for (const file of await packageFiles()) {
      const lines = (await readFile(path.join(packagesDir, file), "utf8")).split("\n");
      if (lines.includes("## Evidence and handoff")) {
        failures.push(`${file} uses a combined "## Evidence and handoff" heading`);
      }
      if (lines.filter((line) => line === "## Evidence").length !== 1) {
        failures.push(`${file} does not carry exactly one "## Evidence" section`);
      }
      if (lines.filter((line) => line === "## Handoff").length !== 1) {
        failures.push(`${file} does not carry exactly one "## Handoff" section`);
      }
      const evidenceAt = lines.indexOf("## Evidence");
      const risksAt = lines.indexOf("## Risks and decisions");
      const handoffAt = lines.indexOf("## Handoff");
      if (
        evidenceAt < 0 ||
        risksAt < 0 ||
        handoffAt < 0 ||
        evidenceAt > risksAt ||
        risksAt > handoffAt
      ) {
        failures.push(`${file} does not follow the template Evidence/Risks/Handoff order`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("keeps settlement state in Handoff instead of header duplicates", async () => {
    const failures: string[] = [];
    for (const file of await packageFiles()) {
      const source = await readFile(path.join(packagesDir, file), "utf8");
      const lines = source.split("\n");
      const firstSection = lines.findIndex((line) => line.startsWith("## "));
      const headerQuotes = lines
        .slice(0, firstSection < 0 ? 0 : firstSection)
        .filter((line) => line.startsWith("> "));
      if (headerQuotes.length > 0) {
        failures.push(`${file} repeats status above the first section instead of Handoff`);
      }
      if (source.includes("see Handoff")) {
        failures.push(`${file} points at Handoff instead of stating settlement there`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("states package status without tooling mechanics", async () => {
    const failures: string[] = [];
    for (const file of await packageFiles()) {
      const source = await readFile(path.join(packagesDir, file), "utf8");
      if (source.includes("pnpm roadmap:check")) {
        failures.push(`${file} explains check mechanics instead of stating package status`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("mvp progress chronology", () => {
  test("header date matches the latest checkpoint entry", async () => {
    const source = await readFile(progressPath, "utf8");
    const header = /^Updated: (\d{1,2}) ([A-Z][a-z]+) (\d{4})$/mu.exec(source);
    expect(header).not.toBeNull();
    const log = source.slice(source.indexOf("## Checkpoint log"));
    const entries = log
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map(datedKey);
    expect(entries.length).toBeGreaterThan(0);
    const datedEntries = entries.filter((entry) => entry !== undefined);
    expect(datedEntries.length).toBe(entries.length);
    const latest = Math.max(...datedEntries);
    expect((MONTHS.get(header?.[2] ?? "") ?? 0) * 100 + Number(header?.[1])).toBe(latest);
  });

  test("checkpoint entries read oldest-first", async () => {
    const source = await readFile(progressPath, "utf8");
    const log = source.slice(source.indexOf("## Checkpoint log"));
    const entries = log
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => datedKey(line));
    const dated = entries.filter((entry) => entry !== undefined);
    expect(dated.length).toBe(entries.length);
    const ordered = [...dated].sort((left, right) => left - right);
    expect(dated).toEqual(ordered);
  });
});

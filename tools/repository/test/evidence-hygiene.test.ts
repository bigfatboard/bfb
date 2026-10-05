// ABOUTME: Locks committed work-package evidence to redacted, machine-neutral content.
// ABOUTME: Fails on local absolute paths and per-run run-log timestamps in the evidence tree.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const evidenceDir = path.join(root, "docs", "work-packages", "evidence");

// A concrete checkout or home path left behind by a local run, e.g.
// `/tmp/bfb-a01-clean`. Bare directory mentions such as "under `/tmp`,"
// carry no machine identity and are allowed.
const LOCAL_ABSOLUTE_PATH =
  /\/(?:tmp|private\/tmp|var\/folders|Users|home)\/[A-Za-z0-9._~+][A-Za-z0-9._~+/|-]*/;

// A per-run wall-clock stamp in a command run row, e.g. `"time":
// "2026-09-18T17:18:00Z"`. Certification dates (`captured_at`,
// `recorded_on`) and fixture clocks (`now`, `expires_at`) are deliberate
// provenance, so only the run-log `time` shape is banned.
const RUN_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const TEXT_EXTENSIONS = new Set([".json", ".jsonl", ".log", ".md", ".mmd"]);

function localPathHit(line: string): string | undefined {
  return LOCAL_ABSOLUTE_PATH.exec(line)?.[0];
}

function collectRunTimestamps(value: unknown, hits: string[], trail: string): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      collectRunTimestamps(entry, hits, `${trail}[${index}]`);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "time" && typeof entry === "string" && RUN_TIMESTAMP.test(entry)) {
        hits.push(`${trail}.${key}=${entry}`);
      } else {
        collectRunTimestamps(entry, hits, `${trail}.${key}`);
      }
    }
  }
}

async function textFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await textFiles(candidate)));
    } else if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      found.push(candidate);
    }
  }
  return found.sort();
}

describe("evidence hygiene", () => {
  test("flags concrete local paths but not bare directory mentions", () => {
    expect(localPathHit("passed from the detached clean checkout /tmp/bfb-a01-clean at")).toBe(
      "/tmp/bfb-a01-clean",
    );
    expect(localPathHit("checkout at /Users/timo/work/tree")).toBe("/Users/timo/work/tree");
    expect(localPathHit("under `/tmp`, a temporary Git working directory")).toBeUndefined();
    expect(localPathHit("exec --cd <tmp> --sandbox read-only")).toBeUndefined();
    expect(localPathHit("no machine paths here")).toBeUndefined();
  });

  test("flags ISO run stamps but not descriptive durations", () => {
    const hits: string[] = [];
    collectRunTimestamps(
      [
        { command: "pnpm test:mvp-discussion", time: "2026-09-18T17:18:00Z" },
        { command: "pnpm verify", time: "bounded synthetic command clock" },
      ],
      hits,
      "$",
    );
    expect(hits).toEqual(["$[0].time=2026-09-18T17:18:00Z"]);
  });

  test("committed evidence carries no local absolute paths", async () => {
    const failures: string[] = [];
    for (const file of await textFiles(evidenceDir)) {
      const lines = (await readFile(file, "utf8")).split("\n");
      for (const [index, line] of lines.entries()) {
        const hit = localPathHit(line);
        if (hit !== undefined) {
          failures.push(`${path.relative(root, file)}:${index + 1}: ${hit}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test("committed command results carry no per-run timestamps", async () => {
    const failures: string[] = [];
    for (const file of await textFiles(evidenceDir)) {
      if (path.extname(file) !== ".json") {
        continue;
      }
      const hits: string[] = [];
      collectRunTimestamps(JSON.parse(await readFile(file, "utf8")), hits, "$");
      for (const hit of hits) {
        failures.push(`${path.relative(root, file)} ${hit}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

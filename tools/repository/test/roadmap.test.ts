// ABOUTME: Exercises roadmap metadata, dependency, readiness, link, and drift failures.
// ABOUTME: Proves generation remains deterministic across repeated clean fixture runs.

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { inspectRoadmap, writeGeneratedRoadmap } from "../src/roadmap.js";

const temporaryRoots: string[] = [];
const markdownTick = String.fromCharCode(96);

interface FixturePackage {
  id: string;
  title?: string;
  filenameId?: string;
  status?: string;
  requires?: string[];
  unlocks?: string[];
  extra?: string;
  readyMetadata?: boolean;
}

function packageSource(fixture: FixturePackage): string {
  const requires = fixture.requires?.join(", ") || "none";
  const unlocks = fixture.unlocks?.join(", ") || "none";
  const status = fixture.status ?? "planned";
  const readyMetadata =
    fixture.readyMetadata === true
      ? [
          "",
          "Test target: " + markdownTick + "pnpm test" + markdownTick,
          "",
          "Evidence manifest: " +
            markdownTick +
            "docs/work-packages/evidence/WP-" +
            fixture.id +
            "/manifest.json" +
            markdownTick,
        ].join("\n")
      : "";
  return [
    "# WP-" + fixture.id + " — " + (fixture.title ?? fixture.id + " package"),
    "",
    "Status: " + markdownTick + status + markdownTick,
    "",
    "Risk: Medium",
    readyMetadata,
    "",
    "## Dependencies",
    "",
    "- **Requires:** " + requires + ".",
    "- **Unlocks:** " + unlocks + ".",
    "- **Can run with:** nothing.",
    "",
    "## Contracts",
    "",
    "### Consumes",
    "",
    "- A frozen input contract.",
    "",
    "### Produces",
    "",
    "- A frozen output contract.",
    "",
    fixture.extra ?? "",
  ].join("\n");
}

async function fixtureRoot(fixtures: FixturePackage[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bfb-roadmap-"));
  temporaryRoots.push(root);
  const directory = path.join(root, "docs/work-packages");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "README.md"),
    [
      "# Roadmap",
      "",
      "<!-- bfb:work-package-graph:start -->",
      "",
      "stale graph",
      "",
      "<!-- bfb:work-package-graph:end -->",
      "",
      "<!-- bfb:work-package-index:start -->",
      "",
      "stale index",
      "",
      "<!-- bfb:work-package-index:end -->",
      "",
    ].join("\n"),
  );
  for (const fixture of fixtures) {
    const filenameId = fixture.filenameId ?? fixture.id;
    await writeFile(
      path.join(directory, "WP-" + filenameId + "-" + fixture.id.toLowerCase() + ".md"),
      packageSource(fixture),
    );
  }
  return root;
}

function issueCodes(inspection: Awaited<ReturnType<typeof inspectRoadmap>>): string[] {
  return inspection.issues.map((issue) => issue.code);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("work-package roadmap", () => {
  test("writes stable graph and index output twice", async () => {
    const root = await fixtureRoot([
      { id: "F01", unlocks: ["F02"] },
      { id: "F02", requires: ["F01"] },
    ]);

    await expect(writeGeneratedRoadmap(root)).resolves.toMatchObject({ issues: [] });
    const first = await readFile(path.join(root, "docs/work-packages/README.md"), "utf8");
    await expect(writeGeneratedRoadmap(root)).resolves.toMatchObject({ issues: [] });
    const second = await readFile(path.join(root, "docs/work-packages/README.md"), "utf8");
    expect(second).toBe(first);
  });

  test("rejects duplicate and filename-mismatched IDs", async () => {
    const root = await fixtureRoot([{ id: "F01" }, { id: "F01", filenameId: "F02" }]);

    const inspection = await inspectRoadmap(root);
    expect(inspection.issues.some((issue) => issue.message.includes("duplicate package ID"))).toBe(
      true,
    );
    expect(inspection.issues.some((issue) => issue.message.includes("does not match"))).toBe(true);
  });

  test("rejects missing and asymmetric dependency declarations", async () => {
    const missingRoot = await fixtureRoot([{ id: "F01", requires: ["F99"] }]);
    expect(issueCodes(await inspectRoadmap(missingRoot))).toContain("dependency");

    const requiresRoot = await fixtureRoot([{ id: "F01" }, { id: "F02", requires: ["F01"] }]);
    expect(issueCodes(await inspectRoadmap(requiresRoot))).toContain("dependency");

    const unlocksRoot = await fixtureRoot([{ id: "F01", unlocks: ["F02"] }, { id: "F02" }]);
    expect(issueCodes(await inspectRoadmap(unlocksRoot))).toContain("dependency");
  });

  test("rejects dependency cycles", async () => {
    const root = await fixtureRoot([
      { id: "F01", requires: ["F02"], unlocks: ["F02"] },
      { id: "F02", requires: ["F01"], unlocks: ["F01"] },
    ]);

    expect(issueCodes(await inspectRoadmap(root))).toContain("cycle");
  });

  test("rejects incomplete ready metadata and broken package links", async () => {
    const root = await fixtureRoot([
      {
        id: "F01",
        status: "ready",
        extra: "[Missing](missing.md)",
      },
    ]);

    const codes = issueCodes(await inspectRoadmap(root));
    expect(codes).toContain("metadata");
    expect(codes).toContain("links");
  });

  test("rejects a review package without a valid evidence manifest", async () => {
    const root = await fixtureRoot([
      {
        id: "F01",
        status: "review",
        readyMetadata: true,
      },
    ]);

    expect(issueCodes(await inspectRoadmap(root))).toContain("evidence");
  });

  test("detects changes in either generated block", async () => {
    const root = await fixtureRoot([{ id: "F01" }]);
    await writeGeneratedRoadmap(root);
    const readmePath = path.join(root, "docs/work-packages/README.md");
    const generated = await readFile(readmePath, "utf8");

    await writeFile(readmePath, generated.replace("flowchart TD", "flowchart LR"));
    expect(issueCodes(await inspectRoadmap(root))).toContain("drift");

    await writeFile(readmePath, generated.replace("| F01 |", "| F99 |"));
    expect(issueCodes(await inspectRoadmap(root))).toContain("drift");
  });
});

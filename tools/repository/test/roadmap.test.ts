// ABOUTME: Exercises roadmap metadata, dependency, readiness, link, and drift failures.
// ABOUTME: Proves generation remains deterministic across repeated clean fixture runs.

import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  requiresMetadata?: string;
  unlocks?: string[];
  extra?: string;
  readyMetadata?: boolean;
  evidenceManifest?: string;
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
            (fixture.evidenceManifest ??
              "docs/work-packages/evidence/WP-" + fixture.id + "/manifest.json") +
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
    "- **Requires:** " + (fixture.requiresMetadata ?? requires + "."),
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

interface EvidenceOptions {
  command?: string;
  environmentKind?: "local" | "ci" | "clean_checkout" | "staging" | "production";
  outcome?: "passed" | "failed" | "not_run";
  commandOutcome?: "passed" | "failed" | "not_run";
  redactionStatus?: "passed" | "failed" | "not_run";
  artifact?: string;
  writeArtifact?: boolean;
  ciStatus?: "passed" | "failed" | "pending" | "not_run";
}

async function writeEvidence(
  root: string,
  packageId: string,
  options: EvidenceOptions = {},
): Promise<void> {
  const directory = path.join(root, "docs/work-packages/evidence/WP-" + packageId);
  const artifact =
    options.artifact ?? "docs/work-packages/evidence/WP-" + packageId + "/result.json";
  await mkdir(directory, { recursive: true });
  if (options.writeArtifact !== false) {
    await writeFile(path.join(root, artifact), "{}\n");
  }
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify(
      {
        package: packageId,
        tested_commit: "a".repeat(40),
        protocol_version: null,
        schema_version: null,
        migration_head: null,
        toolchains: { node: "24.19.0" },
        environment: {
          kind: options.environmentKind ?? "clean_checkout",
          os: "test",
          architecture: "arm64",
        },
        commands: [
          {
            command: options.command ?? "pnpm test",
            outcome: options.commandOutcome ?? "passed",
            artifact,
          },
        ],
        outcome: options.outcome ?? "passed",
        artifacts: [artifact],
        redaction: { status: options.redactionStatus ?? "passed", prohibited_content: [] },
        ci: { status: options.ciStatus ?? "passed", run_url: "https://example.com/runs/1" },
      },
      null,
      2,
    ) + "\n",
  );
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

  test("rejects package prefixes outside the repository taxonomy", async () => {
    const root = await fixtureRoot([{ id: "Z01" }]);

    const inspection = await inspectRoadmap(root);
    expect(
      inspection.issues.some((issue) => issue.message.includes("unsupported package prefix")),
    ).toBe(true);
  });

  test("rejects missing and asymmetric dependency declarations", async () => {
    const missingRoot = await fixtureRoot([{ id: "F01", requires: ["F99"] }]);
    expect(issueCodes(await inspectRoadmap(missingRoot))).toContain("dependency");

    const requiresRoot = await fixtureRoot([{ id: "F01" }, { id: "F02", requires: ["F01"] }]);
    expect(issueCodes(await inspectRoadmap(requiresRoot))).toContain("dependency");

    const unlocksRoot = await fixtureRoot([{ id: "F01", unlocks: ["F02"] }, { id: "F02" }]);
    expect(issueCodes(await inspectRoadmap(unlocksRoot))).toContain("dependency");
  });

  test("rejects malformed and placeholder dependency metadata", async () => {
    for (const requiresMetadata of ["TBD.", "none, F01."]) {
      const root = await fixtureRoot([{ id: "F02", requiresMetadata }]);
      expect(issueCodes(await inspectRoadmap(root))).toContain("metadata");
    }
  });

  test("rejects dependency cycles", async () => {
    const root = await fixtureRoot([
      { id: "F01", requires: ["F02"], unlocks: ["F02"] },
      { id: "F02", requires: ["F01"], unlocks: ["F01"] },
    ]);

    expect(issueCodes(await inspectRoadmap(root))).toContain("cycle");
  });

  test("rejects a ready package whose dependencies are not done", async () => {
    const root = await fixtureRoot([
      { id: "F01", unlocks: ["F02"] },
      { id: "F02", status: "ready", readyMetadata: true, requires: ["F01"] },
    ]);

    const inspection = await inspectRoadmap(root);
    expect(
      inspection.issues.some((issue) =>
        issue.message.includes("F02 is ready but requires F01 with status planned"),
      ),
    ).toBe(true);
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

  test("rejects evidence-manifest paths outside the repository", async () => {
    for (const evidenceManifest of ["../manifest.json", "docs/evidence/../manifest.json"]) {
      const root = await fixtureRoot([
        {
          id: "F01",
          status: "ready",
          readyMetadata: true,
          evidenceManifest,
        },
      ]);
      expect(issueCodes(await inspectRoadmap(root))).toContain("metadata");
    }
  });

  test("rejects every non-passing evidence state for a done package", async () => {
    const cases: EvidenceOptions[] = [
      { outcome: "failed" },
      { commandOutcome: "not_run" },
      { redactionStatus: "failed" },
      { ciStatus: "pending" },
    ];
    for (const options of cases) {
      const root = await fixtureRoot([{ id: "F01", status: "done", readyMetadata: true }]);
      await writeEvidence(root, "F01", options);
      expect(issueCodes(await inspectRoadmap(root))).toContain("evidence");
    }
  });

  test("accepts complete passing evidence for a done package", async () => {
    const root = await fixtureRoot([{ id: "F01", status: "done", readyMetadata: true }]);
    await writeEvidence(root, "F01");
    await writeGeneratedRoadmap(root);

    await expect(inspectRoadmap(root)).resolves.toMatchObject({ issues: [] });
  });

  test("requires a done package evidence manifest to run its exact test target", async () => {
    const root = await fixtureRoot([{ id: "F01", status: "done", readyMetadata: true }]);
    await writeEvidence(root, "F01", { command: "true" });

    expect(issueCodes(await inspectRoadmap(root))).toContain("evidence");
  });

  test("requires clean-checkout evidence for a done package", async () => {
    for (const environmentKind of ["local", "ci", "staging", "production"] as const) {
      const root = await fixtureRoot([{ id: "F01", status: "done", readyMetadata: true }]);
      await writeEvidence(root, "F01", { environmentKind });

      expect(issueCodes(await inspectRoadmap(root))).toContain("evidence");
    }
  });

  test("allows local evidence while a package remains in review", async () => {
    const root = await fixtureRoot([{ id: "F01", status: "review", readyMetadata: true }]);
    await writeEvidence(root, "F01", { environmentKind: "local" });
    await writeGeneratedRoadmap(root);

    await expect(inspectRoadmap(root)).resolves.toMatchObject({ issues: [] });
  });

  test("rejects schema-invalid CI evidence", async () => {
    const root = await fixtureRoot([{ id: "F01", status: "review", readyMetadata: true }]);
    await writeEvidence(root, "F01");
    const manifestPath = path.join(root, "docs/work-packages/evidence/WP-F01/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.ci = null;
    await writeFile(manifestPath, JSON.stringify(manifest) + "\n");

    expect(issueCodes(await inspectRoadmap(root))).toContain("evidence");
  });

  test("rejects array coercion in evidence enums", async () => {
    const root = await fixtureRoot([{ id: "F01", status: "done", readyMetadata: true }]);
    await writeEvidence(root, "F01");
    const manifestPath = path.join(root, "docs/work-packages/evidence/WP-F01/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.outcome = ["passed"];
    await writeFile(manifestPath, JSON.stringify(manifest) + "\n");

    expect(issueCodes(await inspectRoadmap(root))).toContain("evidence");
  });

  test("rejects evidence paths forbidden by the manifest schema", async () => {
    const root = await fixtureRoot([{ id: "F01", status: "review", readyMetadata: true }]);
    await writeEvidence(root, "F01", {
      artifact: "docs/work-packages/evidence/WP-F01/result..json",
    });

    expect(issueCodes(await inspectRoadmap(root))).toContain("evidence");
  });

  test("rejects evidence that references a missing artifact", async () => {
    const root = await fixtureRoot([{ id: "F01", status: "review", readyMetadata: true }]);
    await writeEvidence(root, "F01", { writeArtifact: false });

    expect(issueCodes(await inspectRoadmap(root))).toContain("evidence");
  });

  test("rejects evidence that resolves through a symlink outside the repository", async () => {
    const root = await fixtureRoot([{ id: "F01", status: "review", readyMetadata: true }]);
    const artifact = "docs/work-packages/evidence/WP-F01/result.json";
    await writeEvidence(root, "F01", { artifact, writeArtifact: false });
    const target = root + "-outside.json";
    temporaryRoots.push(target);
    await writeFile(target, "{}\n");
    await symlink(target, path.join(root, artifact));

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

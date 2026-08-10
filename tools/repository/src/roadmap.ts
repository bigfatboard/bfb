// ABOUTME: Parses and validates BFB work-package metadata and dependency relationships.
// ABOUTME: Generates the marked roadmap graph and index deterministically from package files.

import { access, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateMarkdownLinks } from "./docs.js";

const packageIdPattern = "[A-Z]\\d{2}[A-Z]?";
const packageFilePattern = /^WP-.*\.md$/u;
const allowedStatuses = new Set(["planned", "ready", "in_progress", "review", "done", "blocked"]);
const allowedRisks = new Set(["Low", "Medium", "High", "Very high"]);
const readyStatuses = new Set(["ready", "in_progress", "review", "done"]);
const evidenceStatuses = new Set(["review", "done"]);
const graphStart = "<!-- bfb:work-package-graph:start -->";
const graphEnd = "<!-- bfb:work-package-graph:end -->";
const indexStart = "<!-- bfb:work-package-index:start -->";
const indexEnd = "<!-- bfb:work-package-index:end -->";
const tick = String.fromCharCode(96);

const categories = [
  { title: "Foundation", prefixes: ["F"] },
  { title: "Control plane", prefixes: ["C"] },
  { title: "Local execution", prefixes: ["L"] },
  { title: "Web and realtime", prefixes: ["W", "E"] },
  { title: "Agent and human loop", prefixes: ["A"] },
  { title: "Visual review", prefixes: ["V"] },
  { title: "Provider parity", prefixes: ["P"] },
  { title: "External surfaces and operations", prefixes: ["X"] },
  { title: "Go-live", prefixes: ["G"] },
] as const;

export type RoadmapIssueCode =
  "cycle" | "dependency" | "drift" | "evidence" | "links" | "markers" | "metadata";

export interface RoadmapIssue {
  code: RoadmapIssueCode;
  message: string;
}

export interface WorkPackage {
  id: string;
  title: string;
  status: string;
  risk: string;
  filename: string;
  requires: string[];
  unlocks: string[];
  testTarget: string | undefined;
  evidenceManifest: string | undefined;
  consumes: string;
  produces: string;
}

export interface RoadmapInspection {
  packages: WorkPackage[];
  issues: RoadmapIssue[];
  generatedReadme: string | undefined;
}

function metadataValue(source: string, label: string): string | undefined {
  const expression = new RegExp("^" + label + ": \\x60([^\\x60]+)\\x60$", "mu");
  return source.match(expression)?.[1];
}

function dependencyIds(source: string, label: string): string[] | undefined {
  const expression = new RegExp("^- \\*\\*" + label + ":\\*\\* (.+)$", "mu");
  const value = source.match(expression)?.[1];
  if (value === undefined) {
    return undefined;
  }
  if (/^none\b/iu.test(value)) {
    return [];
  }
  return Array.from(value.matchAll(new RegExp("\\b" + packageIdPattern + "\\b", "gu")), (match) =>
    String(match[0]),
  );
}

function subsection(source: string, heading: string): string {
  const start = source.indexOf("### " + heading);
  if (start < 0) {
    return "";
  }
  const bodyStart = source.indexOf("\n", start);
  if (bodyStart < 0) {
    return "";
  }
  const rest = source.slice(bodyStart + 1);
  const nextHeading = rest.search(/^#{2,3} /mu);
  return (nextHeading < 0 ? rest : rest.slice(0, nextHeading)).trim();
}

function isPlaceholder(value: string | undefined): boolean {
  return (
    value === undefined ||
    value.trim().length === 0 ||
    /(?:<[^>]+>|\bTBD\b|\bTODO\b|placeholder)/iu.test(value)
  );
}

function categoryIndex(id: string): number {
  const prefix = id[0] ?? "";
  const index = categories.findIndex((category) =>
    category.prefixes.some((candidate) => candidate === prefix),
  );
  return index < 0 ? categories.length : index;
}

function prefixIndex(id: string): number {
  const category = categories[categoryIndex(id)];
  return category?.prefixes.indexOf(id[0] as never) ?? 0;
}

function comparePackages(left: WorkPackage, right: WorkPackage): number {
  return (
    categoryIndex(left.id) - categoryIndex(right.id) ||
    prefixIndex(left.id) - prefixIndex(right.id) ||
    left.id.localeCompare(right.id)
  );
}

function parsePackage(
  filename: string,
  source: string,
): {
  workPackage?: WorkPackage;
  issues: RoadmapIssue[];
} {
  const issues: RoadmapIssue[] = [];
  const heading = source.match(new RegExp("^# WP-(" + packageIdPattern + ") (?:—|-) (.+)$", "mu"));
  const id = heading?.[1];
  const title = heading?.[2]?.trim();
  const status = metadataValue(source, "Status");
  const risk = source.match(/^Risk: (.+)$/mu)?.[1]?.trim();
  const requires = dependencyIds(source, "Requires");
  const unlocks = dependencyIds(source, "Unlocks");
  const hasConcurrencyBoundary = /^- \*\*Can run with:\*\* .+$/mu.test(source);

  if (id === undefined || title === undefined) {
    issues.push({ code: "metadata", message: filename + " has an invalid package heading" });
  } else if (!filename.startsWith("WP-" + id + "-")) {
    issues.push({
      code: "metadata",
      message: filename + " does not match heading package ID " + id,
    });
  }
  if (status === undefined || !allowedStatuses.has(status)) {
    issues.push({ code: "metadata", message: filename + " has an invalid or missing Status" });
  }
  if (risk === undefined || !allowedRisks.has(risk)) {
    issues.push({ code: "metadata", message: filename + " has an invalid or missing Risk" });
  }
  if (requires === undefined) {
    issues.push({ code: "metadata", message: filename + " is missing Requires metadata" });
  }
  if (unlocks === undefined) {
    issues.push({ code: "metadata", message: filename + " is missing Unlocks metadata" });
  }
  if (!hasConcurrencyBoundary) {
    issues.push({ code: "metadata", message: filename + " is missing Can run with metadata" });
  }

  if (
    id === undefined ||
    title === undefined ||
    status === undefined ||
    risk === undefined ||
    requires === undefined ||
    unlocks === undefined
  ) {
    return { issues };
  }

  const testTarget = metadataValue(source, "Test target");
  const evidenceManifest = metadataValue(source, "Evidence manifest");
  const consumes = subsection(source, "Consumes");
  const produces = subsection(source, "Produces");
  if (readyStatuses.has(status)) {
    if (isPlaceholder(testTarget)) {
      issues.push({
        code: "metadata",
        message: id + " cannot be " + status + " without a stable Test target",
      });
    }
    if (
      isPlaceholder(evidenceManifest) ||
      evidenceManifest === undefined ||
      path.isAbsolute(evidenceManifest) ||
      !evidenceManifest.endsWith(".json")
    ) {
      issues.push({
        code: "metadata",
        message: id + " cannot be " + status + " without a stable evidence-manifest path",
      });
    }
    if (isPlaceholder(consumes)) {
      issues.push({
        code: "metadata",
        message: id + " cannot be " + status + " without a non-empty Consumes contract",
      });
    }
    if (isPlaceholder(produces)) {
      issues.push({
        code: "metadata",
        message: id + " cannot be " + status + " without a non-empty Produces contract",
      });
    }
  }

  return {
    workPackage: {
      id,
      title,
      status,
      risk,
      filename,
      requires: [...new Set(requires)].sort(),
      unlocks: [...new Set(unlocks)].sort(),
      testTarget,
      evidenceManifest,
      consumes,
      produces,
    },
    issues,
  };
}

function validateDependencies(packages: WorkPackage[]): RoadmapIssue[] {
  const issues: RoadmapIssue[] = [];
  const byId = new Map<string, WorkPackage>();
  for (const workPackage of packages) {
    if (byId.has(workPackage.id)) {
      issues.push({ code: "metadata", message: "duplicate package ID " + workPackage.id });
    } else {
      byId.set(workPackage.id, workPackage);
    }
  }

  for (const workPackage of packages) {
    for (const requirement of workPackage.requires) {
      const dependency = byId.get(requirement);
      if (dependency === undefined) {
        issues.push({
          code: "dependency",
          message: workPackage.id + " requires missing package " + requirement,
        });
      } else if (!dependency.unlocks.includes(workPackage.id)) {
        issues.push({
          code: "dependency",
          message:
            workPackage.id +
            " requires " +
            requirement +
            " but " +
            requirement +
            " does not unlock " +
            workPackage.id,
        });
      }
    }

    for (const unlockedId of workPackage.unlocks) {
      const unlocked = byId.get(unlockedId);
      if (unlocked === undefined) {
        issues.push({
          code: "dependency",
          message: workPackage.id + " unlocks missing package " + unlockedId,
        });
      } else if (!unlocked.requires.includes(workPackage.id)) {
        issues.push({
          code: "dependency",
          message:
            workPackage.id +
            " unlocks " +
            unlockedId +
            " but " +
            unlockedId +
            " does not require " +
            workPackage.id,
        });
      }
    }
  }

  const states = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const cycles = new Set<string>();

  function visit(id: string): void {
    const state = states.get(id);
    if (state === "visited") {
      return;
    }
    if (state === "visiting") {
      const cycleStart = stack.indexOf(id);
      const cycle = [...stack.slice(cycleStart), id].join(" -> ");
      cycles.add(cycle);
      return;
    }

    states.set(id, "visiting");
    stack.push(id);
    for (const dependency of byId.get(id)?.requires ?? []) {
      if (byId.has(dependency)) {
        visit(dependency);
      }
    }
    stack.pop();
    states.set(id, "visited");
  }

  for (const id of [...byId.keys()].sort()) {
    visit(id);
  }
  for (const cycle of [...cycles].sort()) {
    issues.push({ code: "cycle", message: "dependency cycle: " + cycle });
  }

  return issues;
}

function renderGraph(packages: WorkPackage[]): string {
  const lines = [tick + tick + tick + "mermaid", "flowchart TD"];
  for (const category of categories) {
    const members = packages
      .filter((workPackage) => category.prefixes.includes(workPackage.id[0] as never))
      .sort(comparePackages);
    if (members.length === 0) {
      continue;
    }
    const subgraphId = category.title.replace(/[^A-Za-z0-9]/gu, "");
    lines.push("    subgraph " + subgraphId + '["' + category.title + '"]');
    for (const workPackage of members) {
      const label = (workPackage.id + " " + workPackage.title).replace(/"/gu, '\\"');
      lines.push("        " + workPackage.id + '["' + label + '"]');
    }
    lines.push("    end");
  }
  lines.push("");
  for (const workPackage of [...packages].sort(comparePackages)) {
    for (const requirement of workPackage.requires) {
      lines.push("    " + requirement + " --> " + workPackage.id);
    }
  }
  lines.push(tick + tick + tick);
  return lines.join("\n");
}

function renderIndex(packages: WorkPackage[]): string {
  const lines: string[] = [];
  for (const category of categories) {
    const members = packages
      .filter((workPackage) => category.prefixes.includes(workPackage.id[0] as never))
      .sort(comparePackages);
    if (members.length === 0) {
      continue;
    }
    lines.push(
      "### " + category.title,
      "",
      "| ID | Package | Status | Risk |",
      "| --- | --- | --- | --- |",
    );
    for (const workPackage of members) {
      lines.push(
        "| " +
          workPackage.id +
          " | [" +
          workPackage.title +
          "](" +
          workPackage.filename +
          ") | " +
          tick +
          workPackage.status +
          tick +
          " | " +
          workPackage.risk +
          " |",
      );
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function replaceMarkedBlock(
  source: string,
  start: string,
  end: string,
  generated: string,
): string | undefined {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end);
  if (
    startIndex < 0 ||
    endIndex < 0 ||
    endIndex < startIndex ||
    source.indexOf(start, startIndex + start.length) >= 0 ||
    source.indexOf(end, endIndex + end.length) >= 0
  ) {
    return undefined;
  }
  const before = source.slice(0, startIndex + start.length);
  const after = source.slice(endIndex);
  return before + "\n\n" + generated.trim() + "\n\n" + after;
}

async function validateEvidence(root: string, packages: WorkPackage[]): Promise<RoadmapIssue[]> {
  const issues: RoadmapIssue[] = [];
  for (const workPackage of packages) {
    if (!evidenceStatuses.has(workPackage.status) || workPackage.evidenceManifest === undefined) {
      continue;
    }
    const manifestPath = path.resolve(root, workPackage.evidenceManifest);
    try {
      await access(manifestPath);
      const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
      if (!isValidEvidenceManifest(manifest, workPackage.id)) {
        throw new Error("manifest does not satisfy the repository evidence contract");
      }
    } catch {
      issues.push({
        code: "evidence",
        message:
          workPackage.id +
          " is " +
          workPackage.status +
          " but its evidence manifest is missing or invalid JSON",
      });
    }
  }
  return issues;
}

function isValidEvidenceManifest(value: unknown, packageId: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const manifest = value as Record<string, unknown>;
  const commands = manifest.commands;
  const artifacts = manifest.artifacts;
  const redaction = manifest.redaction;
  const validCommands =
    Array.isArray(commands) &&
    commands.length > 0 &&
    commands.every(
      (command) =>
        typeof command === "object" &&
        command !== null &&
        !Array.isArray(command) &&
        typeof (command as Record<string, unknown>).command === "string" &&
        ["passed", "failed", "not_run"].includes(
          String((command as Record<string, unknown>).outcome),
        ),
    );
  const validArtifacts =
    Array.isArray(artifacts) &&
    artifacts.every(
      (artifact) =>
        typeof artifact === "string" &&
        !path.isAbsolute(artifact) &&
        !artifact.split("/").includes(".."),
    );
  const validRedaction =
    typeof redaction === "object" &&
    redaction !== null &&
    !Array.isArray(redaction) &&
    ["passed", "failed", "not_run"].includes(
      String((redaction as Record<string, unknown>).status),
    ) &&
    Array.isArray((redaction as Record<string, unknown>).prohibited_content);

  return (
    manifest.package === packageId &&
    typeof manifest.tested_commit === "string" &&
    /^[0-9a-f]{40}$/u.test(manifest.tested_commit) &&
    ["passed", "failed", "not_run"].includes(String(manifest.outcome)) &&
    validCommands &&
    validArtifacts &&
    validRedaction
  );
}

export async function inspectRoadmap(root: string): Promise<RoadmapInspection> {
  const packageDirectory = path.join(root, "docs/work-packages");
  const filenames = (await readdir(packageDirectory))
    .filter((filename) => packageFilePattern.test(filename))
    .sort();
  const packages: WorkPackage[] = [];
  const issues: RoadmapIssue[] = [];

  for (const filename of filenames) {
    const source = await readFile(path.join(packageDirectory, filename), "utf8");
    const parsed = parsePackage(filename, source);
    issues.push(...parsed.issues);
    if (parsed.workPackage !== undefined) {
      packages.push(parsed.workPackage);
    }
  }
  packages.sort(comparePackages);
  issues.push(...validateDependencies(packages));
  issues.push(...(await validateEvidence(root, packages)));

  const linkFailures = (await validateMarkdownLinks(root)).filter((failure) =>
    failure.document.startsWith("docs/work-packages/"),
  );
  for (const failure of linkFailures) {
    issues.push({
      code: "links",
      message:
        failure.document + ":" + failure.line + " points to missing local target " + failure.target,
    });
  }

  const readmePath = path.join(packageDirectory, "README.md");
  const currentReadme = await readFile(readmePath, "utf8");
  const withGraph = replaceMarkedBlock(currentReadme, graphStart, graphEnd, renderGraph(packages));
  const generatedReadme =
    withGraph === undefined
      ? undefined
      : replaceMarkedBlock(withGraph, indexStart, indexEnd, renderIndex(packages));
  if (generatedReadme === undefined) {
    issues.push({
      code: "markers",
      message: "work-package README must contain one graph block and one index block",
    });
  } else if (generatedReadme !== currentReadme) {
    issues.push({
      code: "drift",
      message: "work-package README graph or index differs from generated metadata",
    });
  }

  issues.sort(
    (left, right) =>
      left.code.localeCompare(right.code) || left.message.localeCompare(right.message),
  );
  return { packages, issues, generatedReadme };
}

export async function writeGeneratedRoadmap(root: string): Promise<RoadmapInspection> {
  const inspection = await inspectRoadmap(root);
  const blockingIssues = inspection.issues.filter((issue) => issue.code !== "drift");
  if (blockingIssues.length > 0 || inspection.generatedReadme === undefined) {
    return inspection;
  }
  await writeFile(
    path.join(root, "docs/work-packages/README.md"),
    inspection.generatedReadme,
    "utf8",
  );
  return inspectRoadmap(root);
}

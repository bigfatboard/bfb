// ABOUTME: Parses and validates BFB work-package metadata and dependency relationships.
// ABOUTME: Generates the marked roadmap graph and index deterministically from package files.

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateMarkdownLinks } from "./docs.js";
import { resolveExistingRepositoryPath, resolveRepositoryPath } from "./files.js";

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
const allowedPrefixes = new Set<string>(categories.flatMap((category) => [...category.prefixes]));
const evidenceOutcomes = new Set(["passed", "failed", "not_run"]);
const environmentKinds = new Set(["local", "ci", "clean_checkout", "staging", "production"]);
const ciStatuses = new Set(["passed", "failed", "pending", "not_run"]);

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
  if (value === "none.") {
    return [];
  }
  const packageList = new RegExp(
    "^(?:" + packageIdPattern + ")(?:, " + packageIdPattern + ")*\\.$",
    "u",
  );
  if (!packageList.test(value)) {
    return undefined;
  }
  return value.slice(0, -1).split(", ");
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
  root: string,
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
  if (id !== undefined && !allowedPrefixes.has(id[0] ?? "")) {
    issues.push({
      code: "metadata",
      message: filename + " has unsupported package prefix " + id[0],
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
      resolveRepositoryPath(root, evidenceManifest) === undefined ||
      evidenceManifest.includes("..") ||
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
      if (
        dependency !== undefined &&
        readyStatuses.has(workPackage.status) &&
        dependency.status !== "done"
      ) {
        issues.push({
          code: "dependency",
          message:
            workPackage.id +
            " is " +
            workPackage.status +
            " but requires " +
            requirement +
            " with status " +
            dependency.status,
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
    try {
      const manifestPath = await resolveExistingRepositoryPath(root, workPackage.evidenceManifest);
      if (manifestPath === undefined) {
        throw new Error("evidence manifest is missing or outside the repository");
      }
      const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
      const manifest = evidenceManifest(root, value, workPackage.id);
      if (manifest === undefined) {
        throw new Error("manifest does not satisfy the repository evidence contract");
      }
      if (
        workPackage.status === "done" &&
        (manifest.environmentKind !== "clean_checkout" ||
          manifest.outcome !== "passed" ||
          manifest.redaction.status !== "passed" ||
          manifest.commands.some((command) => command.outcome !== "passed") ||
          !manifest.commands.some((command) => command.command === workPackage.testTarget) ||
          (manifest.ci !== undefined && manifest.ci.status !== "passed"))
      ) {
        throw new Error("done packages require passing evidence");
      }
      const referencedArtifacts = new Set([
        ...manifest.artifacts,
        ...manifest.commands.flatMap((command) =>
          command.artifact === undefined ? [] : [command.artifact],
        ),
      ]);
      for (const artifact of referencedArtifacts) {
        if ((await resolveExistingRepositoryPath(root, artifact)) === undefined) {
          throw new Error("evidence artifact is missing or outside the repository");
        }
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

interface EvidenceCommand {
  command: string;
  outcome: string;
  artifact?: string;
}

interface EvidenceManifest {
  commands: EvidenceCommand[];
  outcome: string;
  environmentKind: string;
  artifacts: string[];
  redaction: { status: string; prohibited_content: string[] };
  ci?: { status: string; run_url?: string };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function stringOrNull(value: unknown): boolean {
  return typeof value === "string" || value === null;
}

function enumValue(value: unknown, allowed: Set<string>): value is string {
  return typeof value === "string" && allowed.has(value);
}

function evidencePath(root: string, value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/\s/u.test(value) &&
    !value.includes("..") &&
    resolveRepositoryPath(root, value) !== undefined
  );
}

function validUri(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function evidenceManifest(
  root: string,
  value: unknown,
  packageId: string,
): EvidenceManifest | undefined {
  const manifest = record(value);
  if (
    manifest === undefined ||
    !hasOnlyKeys(manifest, [
      "$schema",
      "package",
      "tested_commit",
      "protocol_version",
      "schema_version",
      "migration_head",
      "toolchains",
      "environment",
      "commands",
      "outcome",
      "artifacts",
      "redaction",
      "ci",
    ]) ||
    (manifest.$schema !== undefined && typeof manifest.$schema !== "string") ||
    manifest.package !== packageId ||
    typeof manifest.tested_commit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(manifest.tested_commit) ||
    !stringOrNull(manifest.protocol_version) ||
    !stringOrNull(manifest.schema_version) ||
    !stringOrNull(manifest.migration_head) ||
    !enumValue(manifest.outcome, evidenceOutcomes)
  ) {
    return undefined;
  }

  const toolchains = record(manifest.toolchains);
  const environment = record(manifest.environment);
  const redaction = record(manifest.redaction);
  const ci = manifest.ci === undefined ? undefined : record(manifest.ci);
  if (
    toolchains === undefined ||
    !Object.values(toolchains).every((item) => typeof item === "string") ||
    environment === undefined ||
    !hasOnlyKeys(environment, ["kind", "os", "architecture"]) ||
    !enumValue(environment.kind, environmentKinds) ||
    typeof environment.os !== "string" ||
    typeof environment.architecture !== "string" ||
    redaction === undefined ||
    !hasOnlyKeys(redaction, ["status", "prohibited_content"]) ||
    !enumValue(redaction.status, evidenceOutcomes) ||
    !Array.isArray(redaction.prohibited_content) ||
    !redaction.prohibited_content.every((item) => typeof item === "string") ||
    (manifest.ci !== undefined && ci === undefined) ||
    (ci !== undefined &&
      (!hasOnlyKeys(ci, ["status", "run_url"]) ||
        !enumValue(ci.status, ciStatuses) ||
        (ci.run_url !== undefined && !validUri(ci.run_url))))
  ) {
    return undefined;
  }

  if (!Array.isArray(manifest.commands) || manifest.commands.length === 0) {
    return undefined;
  }
  const commands: EvidenceCommand[] = [];
  for (const value of manifest.commands) {
    const command = record(value);
    if (
      command === undefined ||
      !hasOnlyKeys(command, ["command", "outcome", "artifact"]) ||
      typeof command.command !== "string" ||
      command.command.length === 0 ||
      !enumValue(command.outcome, evidenceOutcomes) ||
      (command.artifact !== undefined && !evidencePath(root, command.artifact))
    ) {
      return undefined;
    }
    commands.push({
      command: command.command,
      outcome: command.outcome,
      ...(typeof command.artifact === "string" ? { artifact: command.artifact } : {}),
    });
  }

  if (
    !Array.isArray(manifest.artifacts) ||
    !manifest.artifacts.every((artifact) => evidencePath(root, artifact)) ||
    new Set(manifest.artifacts).size !== manifest.artifacts.length
  ) {
    return undefined;
  }

  return {
    commands,
    outcome: manifest.outcome,
    environmentKind: environment.kind,
    artifacts: manifest.artifacts,
    redaction: {
      status: redaction.status,
      prohibited_content: redaction.prohibited_content,
    },
    ...(ci === undefined
      ? {}
      : {
          ci: {
            status: String(ci.status),
            ...(typeof ci.run_url === "string" ? { run_url: ci.run_url } : {}),
          },
        }),
  };
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
    const parsed = parsePackage(root, filename, source);
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

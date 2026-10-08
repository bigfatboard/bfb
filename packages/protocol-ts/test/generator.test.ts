// ABOUTME: Exercises strict protocol generation failures before wire artifacts can drift.
// ABOUTME: Rejects unknown schema keywords, missing references, and duplicate schema IDs.

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import ts from "typescript";

import { generateProtocol } from "../../../tools/protocol/src/generate.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const temporaryRoots: string[] = [];

async function temporaryProtocol(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bfb-protocol-generator-"));
  temporaryRoots.push(root);
  await cp(path.join(repositoryRoot, "protocol"), path.join(root, "protocol"), {
    recursive: true,
  });
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("strict protocol generation", () => {
  it("rejects an unknown JSON Schema keyword", async () => {
    const root = await temporaryProtocol();
    const schemaPath = path.join(root, "protocol/schema/v1/runner-enrollment.json");
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as Record<string, unknown>;
    schema.maxLenght = 10;
    await writeFile(schemaPath, JSON.stringify(schema));

    await expect(generateProtocol(root, { formatCwd: repositoryRoot })).rejects.toThrow(
      "unknown keyword",
    );
  });

  it("rejects an unresolved schema reference", async () => {
    const root = await temporaryProtocol();
    const schemaPath = path.join(root, "protocol/schema/v1/runner-enrollment.json");
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as {
      properties: Record<string, { $ref?: string }>;
    };
    schema.properties.runner_id = { $ref: "missing.json#/$defs/Ulid" };
    await writeFile(schemaPath, JSON.stringify(schema));

    await expect(generateProtocol(root, { formatCwd: repositoryRoot })).rejects.toThrow(
      /missing schema file|can't resolve reference/u,
    );
  });

  it("rejects duplicate schema IDs", async () => {
    const root = await temporaryProtocol();
    const first = JSON.parse(
      await readFile(path.join(root, "protocol/schema/v1/runner-enrollment.json"), "utf8"),
    ) as { $id: string };
    const schemaPath = path.join(root, "protocol/schema/v1/checkout-summary.json");
    const second = JSON.parse(await readFile(schemaPath, "utf8")) as { $id: string };
    second.$id = first.$id;
    await writeFile(schemaPath, JSON.stringify(second));

    await expect(generateProtocol(root, { formatCwd: repositoryRoot })).rejects.toThrow(
      "duplicate schema $id",
    );
  });

  it("generates conditional records as discriminated unions", async () => {
    const root = await temporaryProtocol();
    await generateProtocol(root, { formatCwd: repositoryRoot });
    const types = await readFile(
      path.join(root, "packages/protocol-ts/src/generated/types.ts"),
      "utf8",
    );

    expect(types).toMatch(/decision: "authorized";[\s\S]*rejection\?: never;/u);
    expect(types).toMatch(/decision: "rejected";[\s\S]*rejection: \{/u);
    expect(types).toMatch(/disposition: "accepted";[\s\S]*diagnostic\?: never;/u);
    expect(types).toMatch(/disposition: "retryable";[\s\S]*diagnostic: \{/u);
    expect(types).toMatch(/purpose: "token";[\s\S]*token_id: null;\s*request: null;/u);
    expect(types).toMatch(/purpose: "request";[\s\S]*token_id: string;\s*request: \{/u);
  });

  it("keeps enum-array items inside the array type", async () => {
    const root = await temporaryProtocol();
    await generateProtocol(root, { formatCwd: repositoryRoot });
    const check = path.join(root, "array-check.ts");
    await writeFile(
      check,
      'import type { RunnerInventory } from "./packages/protocol-ts/src/generated/types.js";\ndeclare const inventory: RunnerInventory;\nconst capabilities: string[] = inventory.providers[0]!.capabilities;\nvoid capabilities;\n',
    );
    const program = ts.createProgram([check], {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      types: [],
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
    });
    expect(
      program
        .getSemanticDiagnostics()
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    ).toEqual([]);
  });
});

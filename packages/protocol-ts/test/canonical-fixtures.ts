// ABOUTME: Emits TypeScript codec outcomes for the shared cross-language fixture matrix.
// ABOUTME: Gives the Go suite one deterministic differential result for every fixture.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decodeWireDocument } from "../src/codec.js";
import type { WireDocumentName } from "../src/generated/types.js";

interface Matrix {
  fixtures: Array<{ path: string; schema: WireDocumentName }>;
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureRoot = path.join(repositoryRoot, "protocol/fixtures/v1");
const matrix = JSON.parse(readFileSync(path.join(fixtureRoot, "matrix.json"), "utf8")) as Matrix;
const outcomes: Record<string, { ok: boolean; json?: string; category?: string }> = {};

for (const fixture of matrix.fixtures) {
  const input = readFileSync(path.join(fixtureRoot, fixture.path));
  const result = decodeWireDocument(fixture.schema, input);
  outcomes[fixture.path] = result.ok
    ? { ok: true, json: result.json }
    : { ok: false, category: result.error.category };
}

process.stdout.write(JSON.stringify(outcomes));

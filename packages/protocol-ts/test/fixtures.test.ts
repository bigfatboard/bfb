// ABOUTME: Runs the cross-language golden fixture matrix through the TypeScript wire codec.
// ABOUTME: Accepts and rejects fixtures using real schema validation, not reimplemented rules.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { decodeWireDocument, encodeWireDocument } from "../src/codec.js";
import type { WireDocumentName } from "../src/generated/types.js";

interface MatrixEntry {
  path: string;
  schema: WireDocumentName;
  expect: "accept" | "reject";
  category?: string;
}

interface Matrix {
  protocol: string;
  schema_version: number;
  fixtures: MatrixEntry[];
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixturesRoot = path.join(repoRoot, "protocol/fixtures/v1");
const matrix = JSON.parse(readFileSync(path.join(fixturesRoot, "matrix.json"), "utf8")) as Matrix;

describe("wire fixture matrix", () => {
  for (const entry of matrix.fixtures) {
    it(entry.path + " " + entry.expect, () => {
      const raw = readFileSync(path.join(fixturesRoot, entry.path), "utf8");
      const result = decodeWireDocument(entry.schema, raw);
      if (entry.expect === "accept") {
        expect(result.ok).toBe(true);
        if (result.ok) {
          const reencoded = encodeWireDocument(result.value);
          const again = decodeWireDocument(entry.schema, reencoded);
          expect(again.ok).toBe(true);
          if (again.ok) {
            expect(again.json).toBe(result.json);
          }
        }
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.category).toBe(entry.category);
        }
      }
    });
  }
});

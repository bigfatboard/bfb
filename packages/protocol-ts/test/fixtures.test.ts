// ABOUTME: Runs the cross-language golden fixture matrix through the TypeScript wire codec.
// ABOUTME: Accepts and rejects fixtures using real schema validation, not reimplemented rules.

import { readFileSync, readdirSync } from "node:fs";
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
  it("has the expected protocol head and lists every fixture exactly once", () => {
    expect(matrix.protocol).toBe("bfb-wire/1");
    expect(matrix.schema_version).toBe(1);

    const listed = matrix.fixtures.map((entry) => entry.path);
    expect(new Set(listed).size).toBe(listed.length);
    const onDisk = ["valid", "invalid"].flatMap((directory) =>
      readdirSync(path.join(fixturesRoot, directory))
        .filter((name) => name.endsWith(".json"))
        .map((name) => directory + "/" + name),
    );
    expect([...listed].sort()).toEqual(onDisk.sort());
  });

  it("keeps the runtime codec free of Node built-ins and runtime schema compilation", () => {
    const source = readFileSync(path.join(repoRoot, "packages/protocol-ts/src/codec.ts"), "utf8");
    expect(source).not.toContain('from "node:');
    expect(source).not.toContain("new Ajv");
  });

  it("escapes JSON Pointer diagnostics and omits paths beyond the wire bound", () => {
    const base = JSON.parse(
      readFileSync(path.join(fixturesRoot, "valid/event-envelope.heartbeat.json"), "utf8"),
    ) as Record<string, unknown>;
    const escaped = decodeWireDocument(
      "event-envelope",
      new TextEncoder().encode(JSON.stringify({ ...base, "a/b~c": true })),
    );
    expect(escaped.ok).toBe(false);
    if (!escaped.ok) {
      expect(escaped.error.path).toBe("/a~1b~0c");
    }

    const bounded = decodeWireDocument(
      "event-envelope",
      new TextEncoder().encode(JSON.stringify({ ...base, ["x".repeat(300)]: 1.5 })),
    );
    expect(bounded.ok).toBe(false);
    if (!bounded.ok) {
      expect(bounded.error.category).toBe("additional_field");
      expect(bounded.error.path).toBeUndefined();
      expect(
        decodeWireDocument(
          "typed-error",
          new TextEncoder().encode(encodeWireDocument(bounded.error)),
        ).ok,
      ).toBe(true);
    }
  });

  for (const entry of matrix.fixtures) {
    it(entry.path + " " + entry.expect, () => {
      const raw = readFileSync(path.join(fixturesRoot, entry.path));
      const result = decodeWireDocument(entry.schema, raw);
      if (entry.expect === "accept") {
        expect(result.ok).toBe(true);
        if (result.ok) {
          const reencoded = encodeWireDocument(result.value);
          const again = decodeWireDocument(entry.schema, new TextEncoder().encode(reencoded));
          expect(again.ok).toBe(true);
          if (again.ok) {
            expect(again.json).toBe(result.json);
          }
        }
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.category).toBe(entry.category);
          const diagnostic = decodeWireDocument(
            "typed-error",
            new TextEncoder().encode(encodeWireDocument(result.error)),
          );
          expect(diagnostic.ok).toBe(true);
        }
      }
    });
  }

  it("rejects malformed UTF-8 and a UTF-8 byte-order mark", () => {
    const valid = readFileSync(path.join(fixturesRoot, "valid/event-envelope.heartbeat.json"));
    const malformed = decodeWireDocument("event-envelope", Uint8Array.of(0x7b, 0x22, 0xff));
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.error.code).toBe("invalid_unicode");
    }

    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...valid]);
    const bomResult = decodeWireDocument("event-envelope", withBom);
    expect(bomResult.ok).toBe(false);
    if (!bomResult.ok) {
      expect(bomResult.error.code).toBe("json_parse_failed");
    }
  });

  it("rejects a wire document before decoding when it exceeds the byte bound", () => {
    const result = decodeWireDocument("event-envelope", new Uint8Array(1_048_577));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("bound_exceeded");
      expect(result.error.code).toBe("max_bytes");
    }
  });

  it("bounds structural work before schema validation", () => {
    const entries = Array.from({ length: 4_097 }, (_, index) => `"k${index}":${index}`);
    const result = decodeWireDocument(
      "event-envelope",
      new TextEncoder().encode("{" + entries.join(",") + "}"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("bound_exceeded");
      expect(result.error.code).toBe("max_items");
    }

    const hostileEntries = [...entries, '"surrogate":"\\uD800"'];
    const unicodeResult = decodeWireDocument(
      "event-envelope",
      new TextEncoder().encode("{" + hostileEntries.join(",") + "}"),
    );
    expect(unicodeResult.ok).toBe(false);
    if (!unicodeResult.ok) {
      expect(unicodeResult.error.category).toBe("schema_invalid");
      expect(unicodeResult.error.code).toBe("invalid_unicode");
    }

    const numericArray = new TextEncoder().encode("[" + "0,".repeat(100_000) + "0]");
    const arrayResult = decodeWireDocument("event-envelope", numericArray);
    expect(arrayResult.ok).toBe(false);
    if (!arrayResult.ok) {
      expect(arrayResult.error.category).toBe("type_mismatch");
    }
  });

  it("rejects values the trusted encoder cannot represent", () => {
    expect(() => encodeWireDocument(undefined)).toThrow("not JSON encodable");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => encodeWireDocument(cyclic)).toThrow("not JSON encodable");
  });
});

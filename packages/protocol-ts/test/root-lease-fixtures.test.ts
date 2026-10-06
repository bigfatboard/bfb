// ABOUTME: Validates root-only checkout lease fixtures without weakening frozen strict observations.
// ABOUTME: Pins closed version-two fields, canonical bytes and rejection of release or downgrade attempts.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { decodeWireDocument, encodeNamedWireDocument } from "../src/codec.js";
import type { WireDocumentName } from "../src/generated/types.js";

const matrix = JSON.parse(
  readFileSync(
    new URL("../../../protocol/fixtures/v2/checkout-root-lease-observation.json", import.meta.url),
    "utf8",
  ),
) as {
  owner_command: string;
  schema_version: number;
  fixtures: Array<{
    name: string;
    document: WireDocumentName;
    json: string;
    accept: boolean;
    canonical_sha256?: string;
  }>;
};

describe("closed root lease protocol", () => {
  it("declares its version and owning command", () => {
    expect(matrix.owner_command).toBe("pnpm protocol:generate");
    expect(matrix.schema_version).toBe(2);
    expect(new Set(matrix.fixtures.map((item) => item.name)).size).toBe(matrix.fixtures.length);
  });
  for (const fixture of matrix.fixtures)
    it(fixture.name, () => {
      const decoded = decodeWireDocument(fixture.document, new TextEncoder().encode(fixture.json));
      expect(decoded.ok, decoded.ok ? "" : JSON.stringify(decoded.error)).toBe(fixture.accept);
      if (!decoded.ok) return;
      expect(createHash("sha256").update(decoded.json).digest("hex")).toBe(
        fixture.canonical_sha256,
      );
      expect(encodeNamedWireDocument(fixture.document, decoded.value)).toBe(decoded.json);
    });
});

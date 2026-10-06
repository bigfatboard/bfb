// ABOUTME: Checks closed result-only v5 documents against the production TypeScript codec.
// ABOUTME: Preserves original business fingerprints, capture domains and frozen older wire boundaries.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalAgentWriteRequest,
  decodeWireDocument,
  encodeNamedWireDocument,
} from "../src/codec.js";
import { PROTOCOL_HEAD, type WireDocumentName } from "../src/generated/types.js";

const matrix = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../protocol/fixtures/v5/local-agent-result-rpc.json", import.meta.url),
    ),
    "utf8",
  ),
) as {
  owner_command: string;
  document: string;
  schema_version: number;
  fixtures: Array<{
    name: string;
    document: WireDocumentName;
    json: string;
    accept: boolean;
    canonical_sha256?: string;
    business_json?: string;
    business_sha256?: string;
  }>;
};
describe("protected agent result protocol", () => {
  it("retains the head and records the owning command", () => {
    expect(PROTOCOL_HEAD).toBe("bfb-wire/1");
    expect(matrix.schema_version).toBe(5);
    expect(matrix.document).toBe("local-agent-result-rpc");
    expect(matrix.owner_command).toBe("pnpm protocol:generate");
    expect(new Set(matrix.fixtures.map((f) => f.name)).size).toBe(matrix.fixtures.length);
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
      if (fixture.business_json !== undefined) {
        const business = canonicalAgentWriteRequest(
          "result.submit",
          new TextEncoder().encode(fixture.json),
        );
        expect(business).toBe(fixture.business_json);
        expect(createHash("sha256").update(business).digest("hex")).toBe(fixture.business_sha256);
      }
    });
});

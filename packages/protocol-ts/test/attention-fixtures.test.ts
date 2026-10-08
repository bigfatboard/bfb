// ABOUTME: Runs deterministic online attention fixtures through the production TypeScript codec.
// ABOUTME: Proves bounded closed v4 shapes, canonical parity and exclusion from older wire lanes.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeWireDocument, encodeNamedWireDocument } from "../src/codec.js";
import { PROTOCOL_HEAD, type WireDocumentName } from "../src/generated/types.js";

const matrix = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../protocol/fixtures/v4/local-agent-attention-rpc.json", import.meta.url),
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
  }>;
};

describe("online-only agent attention protocol", () => {
  it("retains the global head and records its separate version and owning command", () => {
    expect(PROTOCOL_HEAD).toBe("bfb-wire/1");
    expect(matrix.document).toBe("local-agent-attention-rpc");
    expect(matrix.schema_version).toBe(4);
    expect(matrix.owner_command).toBe("pnpm protocol:generate");
    expect(new Set(matrix.fixtures.map((fixture) => fixture.name)).size).toBe(
      matrix.fixtures.length,
    );
  });
  for (const fixture of matrix.fixtures)
    it(fixture.name, () => {
      const result = decodeWireDocument(fixture.document, new TextEncoder().encode(fixture.json));
      expect(result.ok, result.ok ? "" : JSON.stringify(result.error)).toBe(fixture.accept);
      if (!result.ok) return;
      expect(createHash("sha256").update(result.json).digest("hex")).toBe(fixture.canonical_sha256);
      expect(encodeNamedWireDocument(fixture.document, result.value)).toBe(result.json);
      const again = decodeWireDocument(fixture.document, new TextEncoder().encode(result.json));
      expect(again.ok).toBe(true);
      if (again.ok) expect(again.json).toBe(result.json);
    });
});

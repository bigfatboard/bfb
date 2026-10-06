// ABOUTME: Validates shared Claude permission fixtures with current and historical enum readers.
// ABOUTME: Proves manual values remain compatible while autonomous values never downgrade silently.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { legacyAutonomyReader } from "../../../tools/protocol/src/autonomous-fixtures.js";
import { decodeWireDocument, encodeNamedWireDocument } from "../src/codec.js";
import type { WireDocumentName } from "../src/generated/types.js";

const root = new URL("../../../protocol/", import.meta.url);
const matrix = JSON.parse(
  readFileSync(new URL("fixtures/v1/claude-autonomy.json", root), "utf8"),
) as {
  owner_command: string;
  fixtures: Array<{
    name: string;
    document: WireDocumentName;
    json: string;
    accept: boolean;
    legacy_accept: boolean;
  }>;
};
const legacy = legacyAutonomyReader(new URL("schema/v1/", root));

describe("explicit autonomous prerelease wire contract", () => {
  it("records deterministic fixture ownership", () =>
    expect(matrix.owner_command).toBe("pnpm protocol:generate"));
  for (const fixture of matrix.fixtures)
    it(fixture.name, () => {
      const result = decodeWireDocument(fixture.document, new TextEncoder().encode(fixture.json));
      expect(result.ok).toBe(fixture.accept);
      expect(legacy(fixture.document, JSON.parse(fixture.json))).toBe(fixture.legacy_accept);
      if (result.ok)
        expect(encodeNamedWireDocument(fixture.document, result.value)).toBe(result.json);
    });
});

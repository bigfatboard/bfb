// ABOUTME: Exercises online artifact v6 wire contracts against deterministic shared fixtures.
// ABOUTME: Preserves closed scopes, safe recovery identity and absence of offline receipts.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeWireDocument, encodeNamedWireDocument } from "../src/codec.js";
import { PROTOCOL_HEAD, type WireDocumentName } from "../src/generated/types.js";

const matrix = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../protocol/fixtures/v6/local-agent-artifact-rpc.json", import.meta.url),
    ),
    "utf8",
  ),
) as {
  owner_command: string;
  document: string;
  schema_version: number;
  synthetic: boolean;
  operation_key: string;
  canonical_request_sha256: string;
  fixtures: Array<{
    name: string;
    document: WireDocumentName;
    json: string;
    accept: boolean;
    canonical_sha256?: string;
  }>;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
describe("online artifact protocol", () => {
  it("names its deterministic owner and keeps the existing protocol head", () => {
    expect(PROTOCOL_HEAD).toBe("bfb-wire/1");
    expect(matrix.owner_command).toBe("pnpm protocol:generate");
    expect(matrix.schema_version).toBe(6);
    expect(matrix.document).toBe("local-agent-artifact-rpc");
    expect(matrix.synthetic).toBe(true);
    expect(new Set(matrix.fixtures.map((fixture) => fixture.name)).size).toBe(
      matrix.fixtures.length,
    );
  });
  for (const fixture of matrix.fixtures)
    it(fixture.name, () => {
      const decoded = decodeWireDocument(fixture.document, new TextEncoder().encode(fixture.json));
      expect(decoded.ok, decoded.ok ? "" : JSON.stringify(decoded.error)).toBe(fixture.accept);
      if (!decoded.ok) return;
      expect(hash(decoded.json)).toBe(fixture.canonical_sha256);
      expect(encodeNamedWireDocument(fixture.document, decoded.value)).toBe(decoded.json);
    });
  it("retains the unchanged operation reference without making path semantic", () => {
    const request = JSON.parse(
      matrix.fixtures.find((fixture) => fixture.name === "agent-artifact-request-minimal")!.json,
    ) as Record<string, unknown> & { reference: Record<string, unknown> };
    expect(hash(encodeNamedWireDocument("agent-artifact-request", request))).toBe(
      matrix.canonical_request_sha256,
    );
    const identity = { tool: "publish_artifact", ...request.reference };
    const sorted = Object.fromEntries(
      Object.entries(identity).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    expect("agent:" + hash(JSON.stringify(sorted))).toBe(matrix.operation_key);
    expect(Object.hasOwn(request, "path")).toBe(false);
    expect(Object.hasOwn(request, "artifact_id")).toBe(false);
  });
});

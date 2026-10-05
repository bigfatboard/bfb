// ABOUTME: Runs the generated closed v2 agent fixture set through the production TypeScript codec.
// ABOUTME: Keeps the document-specific version transition independent of frozen v1 app fixtures.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeWireDocument, encodeNamedWireDocument, encodeWireDocument } from "../src/codec.js";
import type { WireDocumentName } from "../src/generated/types.js";

const matrix = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../protocol/fixtures/v2/local-agent-rpc.json", import.meta.url)),
    "utf8",
  ),
) as {
  document: string;
  schema_version: number;
  fixtures: Array<{
    name: string;
    document: WireDocumentName;
    json: string;
    accept: boolean;
    canonical_sha256?: string;
    progress_request_sha256?: string;
  }>;
};
describe("negotiated agent document fixtures", () => {
  it("records a document-specific version without upgrading the protocol head", () => {
    expect(matrix.document).toBe("local-agent-rpc");
    expect(matrix.schema_version).toBe(2);
    expect(new Set(matrix.fixtures.map((f) => f.name)).size).toBe(matrix.fixtures.length);
  });
  for (const fixture of matrix.fixtures)
    it(fixture.name, () => {
      const result = decodeWireDocument(fixture.document, new TextEncoder().encode(fixture.json));
      expect(result.ok, result.ok ? "" : JSON.stringify(result.error)).toBe(fixture.accept);
      if (result.ok) {
        expect(encodeNamedWireDocument(fixture.document, result.value)).toBe(result.json);
        const again = decodeWireDocument(fixture.document, new TextEncoder().encode(result.json));
        expect(again.ok).toBe(true);
        if (again.ok) expect(again.json).toBe(result.json);
        if (fixture.canonical_sha256) {
          expect(createHash("sha256").update(result.json).digest("hex")).toBe(
            fixture.canonical_sha256,
          );
          const value = result.value as Record<string, unknown>;
          const request =
            fixture.document === "agent-progress-request"
              ? value
              : fixture.document === "agent-progress-local-request"
                ? value.request
                : (
                    (value.payload as Record<string, unknown>).agent_progress_request as Record<
                      string,
                      unknown
                    >
                  ).request;
          const typed = decodeWireDocument(
            "agent-progress-request",
            new TextEncoder().encode(JSON.stringify(request)),
          );
          expect(typed.ok).toBe(true);
          if (typed.ok)
            expect(createHash("sha256").update(typed.json).digest("hex")).toBe(
              fixture.progress_request_sha256,
            );
        }
      }
    });
  it("keeps unqualified integer encoding strict and named encoding closed", () => {
    const fixture = matrix.fixtures.find((entry) => entry.name === "progress.direct.fraction")!;
    const value = JSON.parse(fixture.json) as Record<string, unknown>;
    expect(() => encodeWireDocument(value)).toThrow("expected integer");
    expect(() => encodeNamedWireDocument("agent-comment-request", value)).toThrow();
    expect(() =>
      encodeNamedWireDocument("agent-progress-request", { ...value, Percent: 0.75 }),
    ).toThrow();
    expect(() =>
      encodeNamedWireDocument("agent-progress-request", { ...value, confidence: Infinity }),
    ).toThrow();
  });
});

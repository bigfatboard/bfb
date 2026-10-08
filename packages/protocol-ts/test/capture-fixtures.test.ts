// ABOUTME: Verifies the closed daemon capture documents and negotiated v3 fixtures.
// ABOUTME: Checks cross-language business digests, transcript bytes and frozen version boundaries.

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

interface Fixture {
  name: string;
  document: WireDocumentName;
  json: string;
  accept: boolean;
  canonical_sha256?: string;
  command_name?: string;
  original_request_json?: string;
  business_json?: string;
  business_sha256?: string;
  transcript_sha256?: string;
  error_category?: string;
}
const matrix = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../protocol/fixtures/v3/local-agent-work-rpc.json", import.meta.url),
    ),
    "utf8",
  ),
) as {
  owner_command: string;
  document: string;
  schema_version: number;
  fixtures: Fixture[];
};
const bytes = (value: string) => new TextEncoder().encode(value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
    return Object.fromEntries(
      Object.entries(nested).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  })
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

describe("daemon-owned agent work protocol", () => {
  it("records a separate document version and owning deterministic command", () => {
    expect(PROTOCOL_HEAD).toBe("bfb-wire/1");
    expect(matrix.document).toBe("local-agent-work-rpc");
    expect(matrix.schema_version).toBe(3);
    expect(matrix.owner_command).toBe("pnpm protocol:generate");
    expect(new Set(matrix.fixtures.map((entry) => entry.name)).size).toBe(matrix.fixtures.length);
    expect(new Set(matrix.fixtures.map((entry) => entry.document))).toEqual(
      new Set([
        "agent-capture-confirmation-request",
        "agent-capture-confirmation-result",
        "agent-work-capture",
        "agent-work-replay-request",
        "agent-work-receipt",
        "local-agent-work-rpc",
        "local-agent-rpc",
        "local-rpc",
      ]),
    );
  });
  for (const fixture of matrix.fixtures)
    it(fixture.name, () => {
      const result = decodeWireDocument<Record<string, unknown>>(
        fixture.document,
        bytes(fixture.json),
      );
      expect(result.ok, result.ok ? "" : JSON.stringify(result.error)).toBe(fixture.accept);
      if (!result.ok) {
        if (fixture.error_category) expect(result.error.category).toBe(fixture.error_category);
        return;
      }
      expect(hash(result.json)).toBe(fixture.canonical_sha256);
      expect(encodeNamedWireDocument(fixture.document, result.value)).toBe(result.json);
      const again = decodeWireDocument(fixture.document, bytes(result.json));
      expect(again.ok).toBe(true);
      if (again.ok) expect(again.json).toBe(result.json);
      if (fixture.command_name && fixture.original_request_json) {
        const business = canonicalAgentWriteRequest(
          fixture.command_name,
          bytes(fixture.original_request_json),
        );
        expect(business).toBe(fixture.business_json);
        expect(hash(business)).toBe(fixture.business_sha256);
        const capture = result.value.capture as Record<string, unknown>;
        expect((capture.operation as Record<string, unknown>).payload_hash).toBe(
          "sha256:" + fixture.business_sha256,
        );
        const original = result.value.original_request as Record<string, unknown>;
        const operation = capture.operation as Record<string, unknown>;
        const reference = original.reference as Record<string, unknown>;
        expect(operation.operation_key).toBe(
          "agent:" +
            hash(
              canonical({ tool: fixture.command_name.slice("agent_run.".length), ...reference }),
            ),
        );
      }
      if (fixture.transcript_sha256) {
        const capture =
          fixture.document === "agent-work-capture"
            ? result.value
            : (result.value.capture as Record<string, unknown>);
        const { signature: _signature, ...unsigned } = capture;
        const transcript = "BFB-AGENT-WORK-CAPTURE-V1\n" + canonical(unsigned) + "\n";
        expect(bytes(transcript).byteLength).toBeLessThanOrEqual(8192);
        expect(hash(transcript)).toBe(fixture.transcript_sha256);
      }
    });
  it("keeps omitted priority distinct while transport whitespace does not change identity", () => {
    const omitted = matrix.fixtures.find((entry) => entry.name === "proposal.priority-omitted")!;
    const supplied = matrix.fixtures.find((entry) => entry.name === "proposal.priority-present")!;
    expect(omitted.business_sha256).not.toBe(supplied.business_sha256);
    const plain = matrix.fixtures.find((entry) => entry.name === "agent_run.comment.replay")!;
    const whitespace = matrix.fixtures.find((entry) => entry.name === "comment.whitespace")!;
    expect(plain.business_sha256).toBe(whitespace.business_sha256);
  });
  it("rejects unselected commands and raw unsafe progress without rounding it first", () => {
    expect(() => canonicalAgentWriteRequest("agent_run.get_task", bytes("{}"))).toThrow();
    const accepted = matrix.fixtures.find((entry) => entry.name === "agent_run.progress.replay")!;
    const original = accepted.original_request_json!;
    expect(() =>
      canonicalAgentWriteRequest(
        "agent_run.progress",
        bytes(original.replace('"percent":12.5', '"percent":100.00000000000000001')),
      ),
    ).toThrow();
    expect(() =>
      canonicalAgentWriteRequest(
        "agent_run.progress",
        bytes(original.replace('"confidence":0.75', '"confidence":1e-324')),
      ),
    ).toThrow();
  });
});

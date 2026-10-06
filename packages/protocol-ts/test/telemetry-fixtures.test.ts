// ABOUTME: Checks the shared closed telemetry matrix and exact raw ingest batch slicing.
// ABOUTME: Preserves numeric lexemes for per-item poison dispositions and frozen v1 compatibility.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeRunnerEventBatch,
  decodeWireDocument,
  encodeNamedWireDocument,
} from "../src/codec.js";
import type { WireDocumentName } from "../src/generated/types.js";

const matrix = JSON.parse(
  readFileSync(
    new URL("../../../protocol/fixtures/v2/runner-telemetry-submission.json", import.meta.url),
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
const bytes = (input: string) => new TextEncoder().encode(input);

describe("closed telemetry protocol", () => {
  it("records the separate item version and owning command", () => {
    expect(matrix.owner_command).toBe("pnpm protocol:generate");
    expect(matrix.schema_version).toBe(2);
    expect(new Set(matrix.fixtures.map((item) => item.name)).size).toBe(matrix.fixtures.length);
  });
  for (const fixture of matrix.fixtures)
    it(fixture.name, () => {
      const result = decodeWireDocument(fixture.document, bytes(fixture.json));
      expect(result.ok, result.ok ? "" : JSON.stringify(result.error)).toBe(fixture.accept);
      if (!result.ok) return;
      expect(createHash("sha256").update(result.json).digest("hex")).toBe(fixture.canonical_sha256);
      expect(encodeNamedWireDocument(fixture.document, result.value)).toBe(result.json);
    });
  it("retains unsafe raw counters for a typed per-item rejection", () => {
    const good = matrix.fixtures.find((item) => item.name === "tokens")!.json;
    const poison = good.replace('"input":120', '"input":9007199254740991.1');
    const result = decodeRunnerEventBatch(
      bytes(`{"events":[${poison},${good}],"schema_version":1}`),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.events).toEqual([poison, good]);
    expect(
      decodeWireDocument("runner-telemetry-submission", bytes(result.value.events[0]!)).ok,
    ).toBe(false);
    expect(
      decodeWireDocument("runner-telemetry-submission", bytes(result.value.events[1]!)).ok,
    ).toBe(true);
  });
  it("splits nested escaped strings without treating punctuation as array separators", () => {
    const event = '{"payload":{"text":"\\\"],{}\\\\","nested":[{},[2]]}}';
    const result = decodeRunnerEventBatch(
      bytes(`{"schema_version":1,"events":[ ${event} ,null ]}`),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.events).toEqual([event, "null"]);
  });
  for (const source of [
    '{"schema_version":1,"events":[]}',
    '{"schema_version":1.0000000000000001,"events":[{}]}',
    '{"schema_version":1,"schema_version":1,"events":[{}]}',
    '{"schema_version":1,"events":[{}],"extra":0}',
    '{"schema_version":1,"events":[{}]}{}',
    '{"schema_version":1,"events":[' + Array.from({ length: 26 }, () => "{}").join(",") + "]}",
  ])
    it(`rejects malformed outer batch ${source.slice(0, 60)}`, () =>
      expect(decodeRunnerEventBatch(bytes(source)).ok).toBe(false));
});

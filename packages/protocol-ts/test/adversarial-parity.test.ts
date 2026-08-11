// ABOUTME: Differential adversarial corpus for TypeScript JSON Schema wire decoding.
// ABOUTME: Locks fractional integers, enums, bounds, uniqueness, and required nested fields.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { decodeWireDocument } from "../src/codec.js";
import type { WireDocumentName } from "../src/generated/types.js";

interface Case {
  path: string;
  schema: WireDocumentName;
  category: string;
  concern: "fractional_integer" | "enum" | "bound" | "uniqueness" | "required_nested";
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixturesRoot = path.join(repoRoot, "protocol/fixtures/v1");

/** Adversarial cases that both TypeScript and Go must reject with the same category. */
const adversarialCorpus: Case[] = [
  {
    path: "invalid/event-envelope.fractional-cursor.json",
    schema: "event-envelope",
    category: "type_mismatch",
    concern: "fractional_integer",
  },
  {
    path: "invalid/event-envelope.fractional-schema-version.json",
    schema: "event-envelope",
    category: "type_mismatch",
    concern: "fractional_integer",
  },
  {
    path: "invalid/event-envelope.cursor-below-min.json",
    schema: "event-envelope",
    category: "bound_exceeded",
    concern: "bound",
  },
  {
    path: "invalid/event-envelope.unknown-actor-type.json",
    schema: "event-envelope",
    category: "type_mismatch",
    concern: "enum",
  },
  {
    path: "invalid/event-envelope.missing-actor-type.json",
    schema: "event-envelope",
    category: "missing_field",
    concern: "required_nested",
  },
  {
    path: "invalid/runner-enrollment.duplicate-project-ids.json",
    schema: "runner-enrollment",
    category: "schema_invalid",
    concern: "uniqueness",
  },
  {
    path: "invalid/runner-enrollment.unknown-status.json",
    schema: "runner-enrollment",
    category: "type_mismatch",
    concern: "enum",
  },
  {
    path: "invalid/launch-specification.missing-nested-provider.json",
    schema: "launch-specification",
    category: "missing_field",
    concern: "required_nested",
  },
  {
    path: "invalid/launch-specification.duplicate-capabilities.json",
    schema: "launch-specification",
    category: "schema_invalid",
    concern: "uniqueness",
  },
  {
    path: "invalid/launch-specification.unknown-effort.json",
    schema: "launch-specification",
    category: "type_mismatch",
    concern: "enum",
  },
  {
    path: "invalid/checkout-summary.missing-status.json",
    schema: "checkout-summary",
    category: "missing_field",
    concern: "required_nested",
  },
  {
    path: "invalid/checkout-summary.unknown-status.json",
    schema: "checkout-summary",
    category: "type_mismatch",
    concern: "enum",
  },
  {
    path: "invalid/runner-event-submission.missing-capture-origin.json",
    schema: "runner-event-submission",
    category: "missing_field",
    concern: "required_nested",
  },
  {
    path: "invalid/runner-event-submission.disallowed-kind.json",
    schema: "runner-event-submission",
    category: "unknown_kind",
    concern: "enum",
  },
  {
    path: "invalid/local-rpc.unknown-direction.json",
    schema: "local-rpc",
    category: "type_mismatch",
    concern: "enum",
  },
];

describe("adversarial differential corpus (TypeScript)", () => {
  for (const entry of adversarialCorpus) {
    it(`${entry.concern}: ${entry.path} → ${entry.category}`, () => {
      const raw = readFileSync(path.join(fixturesRoot, entry.path));
      const result = decodeWireDocument(entry.schema, raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.category).toBe(entry.category);
      }
    });
  }

  it("covers all required adversarial concerns", () => {
    const concerns = new Set(adversarialCorpus.map((entry) => entry.concern));
    expect(concerns).toEqual(
      new Set(["fractional_integer", "enum", "bound", "uniqueness", "required_nested"]),
    );
  });
});

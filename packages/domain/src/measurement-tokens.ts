// ABOUTME: Normalizes every supported token alias and stages immutable canonical token observations.
// ABOUTME: Shares validation and persistence between explicit reports and typed event ingestion.

import type { SqlDatabase } from "@bfb/db";
import { DomainError } from "./hub.js";
import type { TokenFields, TokenObservation } from "./measurements.js";

export const TOKEN_FIELD_NAMES = [
  "input",
  "output",
  "cache_read",
  "cache_write",
  "reasoning",
] as const;

const ALIASES = {
  input: ["input", "input_tokens"],
  output: ["output", "output_tokens"],
  cache_read: ["cache_read", "cache_read_tokens", "cached_input_tokens", "cache_read_input_tokens"],
  cache_write: [
    "cache_write",
    "cache_write_tokens",
    "cache_creation_tokens",
    "cache_creation_input_tokens",
  ],
  reasoning: ["reasoning", "reasoning_tokens", "reasoning_output_tokens"],
} as const;
const ALLOWED = new Set<string>(Object.values(ALIASES).flat());

/** Every supplied alias must be valid and agree; missing counters remain null rather than inferred zero. */
export function normalizeTokenFields(raw: unknown): TokenFields {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DomainError("invalid_argument", "token usage must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => !ALLOWED.has(key))) {
    throw new DomainError("invalid_argument", "token usage has an unknown field");
  }
  const fields: TokenFields = {
    input: null,
    output: null,
    cache_read: null,
    cache_write: null,
    reasoning: null,
  };
  for (const field of TOKEN_FIELD_NAMES) {
    let selected: number | null | undefined;
    for (const alias of ALIASES[field]) {
      if (!Object.hasOwn(record, alias)) continue;
      const rawValue = record[alias],
        value = rawValue === undefined ? null : rawValue;
      if (
        value !== null &&
        (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      ) {
        throw new DomainError("invalid_argument", `token field ${alias} is invalid`);
      }
      if (selected !== undefined && selected !== value)
        throw new DomainError("invalid_argument", "token aliases disagree");
      selected = value as number | null;
    }
    fields[field] = selected ?? null;
  }
  return fields;
}

export function tokenFieldsPresent(fields: TokenFields): boolean {
  return TOKEN_FIELD_NAMES.some((name) => fields[name] !== null);
}

/** Queues an already validated observation in the caller's atomic Hub transaction. */
export async function persistTokenObservation(
  db: SqlDatabase,
  workspaceId: string,
  observation: TokenObservation,
): Promise<void> {
  const fields = observation.tokens;
  await db
    .prepare(
      `INSERT INTO token_observations
    (workspace_id, observation_id, run_id, run_execution_id, provider, model,
     input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
     quality, provenance, occurred_at, committed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      workspaceId,
      observation.observation_id,
      observation.run_id,
      observation.run_execution_id,
      observation.provider,
      observation.model,
      fields.input,
      fields.output,
      fields.cache_read,
      fields.cache_write,
      fields.reasoning,
      observation.quality,
      observation.provenance,
      observation.occurred_at,
      observation.committed_at,
    );
}

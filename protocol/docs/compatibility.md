# BFB wire compatibility rules

ABOUTME: States how versioned wire contracts evolve without breaking peers.
ABOUTME: Applies to JSON Schema under protocol/schema and generated codecs.

## Versions

- Every wire document carries integer `schema_version` starting at `1`.
- Protocol head string is `bfb-wire/1` (see `protocol/schema/v1/meta.json`).
- Unknown `schema_version` values fail closed with diagnostic category `unknown_version`.
- Unknown event `kind` values fail closed with category `unknown_kind` unless a later package explicitly documents additive reading.

## Lockstep v1 changes

- Version 1 is a closed contract: every object rejects unknown fields and peers deploy schema, generated validators, types, and fixtures together.
- Adding any field or enum member requires a new negotiated wire version; an optional field is not additive while v1 readers use `additionalProperties: false`.
- Required fields cannot be removed or retyped without a new wire version.
- Deprecation requires an explicit version transition; v1 producers and readers do not silently accept deprecated values.

### Local agent-work transition

[ADR 0005](../../docs/adr/0005-agent-work-session-and-attribution.md) defines a separate closed `local-agent-rpc` envelope at schema version 2. The general `local-rpc` envelope and Swift app calls remain version 1. Fixed `mcp.v2.` methods are negotiated through the already-declared `methods` field of a v1 `daemon.status` response before private input is sent. Unsupported versions or missing methods fail visibly; no automatic downgrade is allowed. Version 2 is accepted only for the named agent document, and replies must match the selected version, method and request ID. The unchanged nested cloud operation reference remains version 1, preserving its idempotency hashes. This is a document-specific transition, not a global upgrade of existing `bfb-wire/1` records.

## Bounds

- Every string, array, object map, and payload has explicit max length or max items in schema.
- A complete wire document is at most 1,048,576 bytes before UTF-8 decoding.
- Wire decoders consume UTF-8 bytes, reject malformed UTF-8, byte-order marks, lone surrogate escapes, and duplicate object keys, including escaped-equivalent keys.
- JSON Schema string lengths count Unicode scalar values. Swift decoders must use `unicodeScalars.count`, not grapheme-cluster count, for these bounds.
- Timestamps are UTC RFC 3339 with a trailing `Z`, second precision minimum, at most six fractional digits, and seconds from `00` through `59`.
- Resource IDs are Crockford ULID strings (`[0-7][0-9A-HJKMNP-TV-Z]{25}`).
- Wire integers use exact JSON number semantics and the inclusive range `-9007199254740991` through `9007199254740991`; mathematically integral decimal/exponent spellings are accepted and re-encoded as canonical integers.
- Agent progress is the sole bounded decimal exception: `percent` (0–100) and `confidence` (0–1) in `agent-progress-request`, its `agent-progress-local-request` wrapper, and the exact request payload of `local-agent-rpc` v2 `mcp.v2.report_progress`. Finite decimal/exponent values are normalized consistently by TypeScript and Go; nonzero underflow and raw out-of-range values fail closed. This does not relax integer fields, similarly named fields elsewhere, or general local RPC v1/Swift validation.
- Oversized values fail with category `bound_exceeded`.

## Intent isolation

- `cloud_wake_intent` and `terminal_intent` are distinct schemas with distinct required `intent_kind` discriminators.
- Neither intent type may carry task text, checkout paths, executables, argv, shell fragments, or cwd.
- Launch specifications forbid `command`, `executable`, `cwd`, `argv`, `shell`, and `working_directory` fields.

## Runner attribution

- Runner-submitted envelopes may include claimed workspace/project/task/run IDs only as non-authoritative hints.
- Authoritative attribution is derived by the control plane from the immutable execution assignment.
- Schemas label claimed attribution fields as optional and non-authoritative; peers must not treat them as grants.

## Diagnostics

Shared diagnostic categories used by TypeScript and Go codecs:

| Category | Meaning |
| --- | --- |
| `schema_invalid` | JSON is malformed, has ambiguous keys/Unicode, violates uniqueness or conditional structure, or otherwise fails non-type schema structure |
| `unknown_version` | Unsupported `schema_version` |
| `unknown_kind` | Unsupported discriminator or event kind |
| `bound_exceeded` | String, array, or payload exceeds schema bounds |
| `type_mismatch` | Field type does not match schema |
| `missing_field` | Required field absent |
| `additional_field` | Disallowed additional property present |
| `intent_confusion` | Wake/Terminal/launch fields used on the wrong type |
| `shell_data` | Forbidden shell/command fields present |
| `authoritative_runner_claim` | Runner attempted to assert cloud-authoritative tenant fields |

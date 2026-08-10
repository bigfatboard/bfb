# BFB wire compatibility rules

ABOUTME: States how versioned wire contracts evolve without breaking peers.
ABOUTME: Applies to JSON Schema under protocol/schema and generated codecs.

## Versions

- Every wire document carries integer `schema_version` starting at `1`.
- Protocol head string is `bfb-wire/1` (see `protocol/schema/v1/meta.json`).
- Unknown `schema_version` values fail closed with diagnostic category `unknown_version`.
- Unknown event `kind` values fail closed with category `unknown_kind` unless a later package explicitly documents additive reading.

## Additive changes

- New optional fields may be added in a later minor schema revision only after fixtures and generated types are updated in the same change.
- Required fields cannot be removed or retyped without a new major `schema_version`.
- Enum additions require fixtures for the new value and rejection fixtures remain for invalid values.
- Deprecation marks a field or kind as readable but non-authoritative; producers must not emit deprecated values once a replacement is required.

## Bounds

- Every string, array, object map, and payload has explicit max length or max items in schema.
- Timestamps are UTC RFC 3339 with a trailing `Z` and second precision minimum.
- Resource IDs are Crockford ULID strings (`[0-9A-HJKMNP-TV-Z]{26}`).
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
| `schema_invalid` | JSON is not an object or fails structural parse |
| `unknown_version` | Unsupported `schema_version` |
| `unknown_kind` | Unsupported discriminator or event kind |
| `bound_exceeded` | String, array, or payload exceeds schema bounds |
| `type_mismatch` | Field type does not match schema |
| `missing_field` | Required field absent |
| `additional_field` | Disallowed additional property present |
| `intent_confusion` | Wake/Terminal/launch fields used on the wrong type |
| `shell_data` | Forbidden shell/command fields present |
| `authoritative_runner_claim` | Runner attempted to assert cloud-authoritative tenant fields |

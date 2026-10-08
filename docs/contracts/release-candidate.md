# BFB v0.1 release candidate (frozen by WP-G01 for WP-G02)

G01 freezes the schema and protocol heads below as the single release
candidate that G02 installs, upgrades, and recovers. Nothing here changes
without a new reviewed migration plan; G02 proves the frozen heads from
blank accounts and blank Macs.

## Frozen heads

| Head | Value | Source of truth |
| --- | --- | --- |
| Wire protocol | `bfb-wire/1` | `packages/protocol-ts/src/generated/types.ts` (`PROTOCOL_HEAD`) |
| Contract schema | `1` | `packages/protocol-ts/src/generated/types.ts` (`SCHEMA_VERSION`) |
| D1 migrations | `0034_operations` | `migrations/d1/manifest.json` (`migration_head`) |
| G01 golden fixture | `bfb-g01/v1` (fixture version 1) | `tools/g01/fixture.ts`, `docs/work-packages/evidence/WP-G01/fixture.json` |

## Pinned providers and auth

| Component | Pinned version | Certified by |
| --- | --- | --- |
| Claude Code reference adapter | Claude `2.1.275`, probe/manifest `1.0.0` | WP-L07 |
| Codex adapter | Codex `0.153.4` | WP-P01 |
| Grok adapter | Grok `1.0.34` | WP-P02 |
| Human auth | Better Auth `1.6.26` | Architecture decision, `apps/control-worker/package.json` |

Provider capability differences stay as documented in WP-L03/WP-P01/WP-P02:
unknown or newly auto-updated versions block automatic tracked behavior
until their fixtures pass; interactive Grok starts may wait for the human
to submit the first prompt where the installed version lacks a safe
auto-submit contract.

## Pre-release gate state handed to G02

- Every gate except AG-02, AG-04, AG-10, and OG-02 is `passed` in
  `docs/work-packages/evidence/WP-G01/gate-report.json`. AG-10 and OG-02
  are `not_run`: G02 owns clean-install and release/rollback proof.
- AG-02 is `failed`, with no waiver in force: WP-L05 Terminal
  certification records one fail-closed clean-checkout failure in five
  full gates and retains only the bounded redacted matrix (no separate
  raw launch trace), so the native launch trace is not a deterministic
  release gate; the cloud-plane launch contention, expiry, and cleanup
  receipts pass in G01. No ADR and no explicit decision authorizes a
  waiver, so the gate fails instead of passing.
- AG-04 is `failed`, with no waiver in force: shared Stop/exit lifecycle
  semantics and capability ceilings pass in G01, but live
  Claude/Codex/Grok turns need provider credentials and consent that are
  unavailable, L07 is `review` pending live Claude credentials, and P01
  and P02 are `planned`. No ADR and no explicit decision authorizes a
  waiver, so the gate fails and this release candidate is not settled
  until AG-02 and AG-04 pass.

## G02 entry procedure

1. Check out the release-candidate commit recorded in
   `docs/work-packages/evidence/WP-G01/manifest.json` (`tested_commit`).
2. Verify the four frozen heads above match this file before installing.
3. Run AG-10 (blank Cloudflare account, blank Mac, first-owner bootstrap,
   provider flow, artifact review) and OG-02 (empty/previous migrations,
   key overlap, Worker/data rollback decision trace) and publish the final
   report; G01 evidence stays the pre-release record.

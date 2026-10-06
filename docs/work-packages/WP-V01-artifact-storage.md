# WP-V01 — Artifact storage state machine

Status: `in_progress`

Risk: High

Test target: `pnpm test:v01`

Evidence manifest: `docs/work-packages/evidence/WP-V01/manifest.json`

## Outcome

An authorized human or currently bound agent can publish a bounded review
artifact or compressed log chunk through typed create → upload → finalize
calls backed by real Workers, D1, and R2. Local MCP and the bound CLI use
daemon-owned authority and scoped files, not caller-selected cloud credentials.

## Dependencies

- **Requires:** A01, C01, C04, F03.
- **Unlocks:** V02, X02, X03, X05.
- **Can run with:** L01, P01.

## Scope

- Repair current project authorization at issuance, redemption and finalization,
  exact one-time consumption identity, and real R2 conditional-write handling.
- Connect online-only run-scoped local publication through the current A01
  native/runner authority boundary with explicit same-identity recovery.
  Its separate closed protocol and artifact/audit bookkeeping contract are
  frozen in [ADR 0010](../adr/0010-connected-artifact-publication.md).
  No A01/A03 offline journal widening.
- Artifact/version/grant upload state machine with format and role as
  separate fields (`markdown`, `mermaid`, `diff`, `svg`, `png`, `jpeg`,
  `html`, `log`, `json`; review 5 MiB, compressed log chunks 1 MiB).
- One-time upload grants bound to principal/grant, authorization epoch,
  workspace, run, version, format, size, digest, and expiry; the D1-backed
  state machine has no custom durable-grant store by design.
- End-to-end create → upload → finalize authorization, revocation, recovery
  of lost grants, and durable abuse controls on every request surface.
- Content verification (MIME binding, digest, size, conditional create) with
  shared content hashes and no public unauthenticated writes.
- D1 artifact schema rooted at `0020_artifact_storage`, with additive
  current-runtime migrations, immutable history, exact consume attempts,
  verified upload receipts, the content-addressed object registry and audit outbox.
- Bound CLI and local MCP through negotiated `mcp.v6.publish_artifact`,
  daemon-owned scope, pinned files and fixed runner prepare/finalize phases.
  The historical general `artifact.publish` client/wire remains separate;
  it is not a native-run capability or current X02 parity certificate.
- Acceptance harness `tools/artifacts/run.ts` proving every bullet against
  real Workers, D1, and disposable R2, with fault injection at every D1/R2
  boundary.

## Non-goals

- Artifact views, renderers, and review surfacing (V02/V03 own them; no
  viewer, renderer, or review work happened here).
- Retention, lifecycle deletion, and client-supplied storage keys.
- Human CLI-credential auth on publication routes (X02), offline automatic
  artifact replay, an outbox watcher, or provider/Terminal acceptance.

## Contracts

### Consumes

- `docs/contracts/workspace-hub.md` — every workspace mutation serializes
  through `WorkspaceHub`; Cron recovery uses the system actor.
- C01 `WorkspaceHub`/durable abuse controls and C04 authorization
  (`packages/domain`: principal load, role/epoch fences, budget buckets).
- F03 Artifact Worker + R2 substrate (`apps/artifact-worker`,
  `tools/substrate`): cookie-less origin, private bucket, Cron discipline.
- D1 layer and current migration chain (`packages/db`, `migrations/d1`),
  retaining historical artifact migrations and evidence unchanged.
- Closed v6 `local-agent-artifact-rpc` and four artifact request/result
  documents; deterministic v6 fixtures and generated TypeScript/Go codecs.
  Historical general v1 `artifact.publish` payloads remain frozen.

### Produces

- `docs/contracts/artifacts.md` (frozen): state machine, grant rules,
  routes, R2 key layout, formats/limits, Go client errors, local-RPC
  payload, and the `bfb_publish_artifact` MCP seam for A01.
- `pnpm test:v01`: domain authority/recovery/audit tests, mounted routes,
  real-Worker D1/R2 fault harness, migration/protocol checks, Go race tests,
  compiled MCP/fresh CLI and signed native runtime proof on macOS.
- `docs/work-packages/evidence/WP-V01/manifest.json`: bounded, redacted
  evidence for the tested commit.

## Work plan

The numbered list records historical component implementation. Current runtime
closure proceeds through authority/storage regressions, the separately documented
closed local publication contract, compiled signed end-to-end proof, and clean
exact-gate certification. Historical manifests are retained without relabelling.

1. D1 migration 0020 with guards and triggers; verified with the migration
   gate. Done.
2. Domain commands (`artifact.create_version`, `artifact.issue_grant`,
   `artifact.finalize_version`, `artifact.mark_failed`) plus redeem/record/
   sweep helpers; verified with `packages/domain/test/artifacts.test.ts`.
   Done.
3. Artifact Worker conditional-consume upload path and control-plane
   publication routes with uniform failures; verified with mounted tests.
   Done.
4. Go client, CLI/daemon entries, MCP seam, local-RPC contract; verified
   with `go test -race`. Done.
5. `tools/artifacts/run.ts` end-to-end (faults, replay, revocation,
   cross-isolate abuse, size/MIME/digest errors, same-hash race); green
   (`V01_D1_OK`). Done.
6. Contract, package file, evidence, checkpoint; `pnpm roadmap:write`.
   Done (this change).

## Acceptance

- Upload-grant state machine authorized end to end across create, upload,
  and finalize; tested in `tools/artifacts/run.ts` (alternating isolates).
- One-time grants bind principal/grant, current authorization epoch,
  workspace, run, version, format, size, digest, and expiry; replay, wrong
  secret, unknown grant, expiry, and revocation never yield an available
  version (matrix below).
- Failure at every D1/R2 step leaves recoverable non-viewable state:
  conflicting objects, D1-consume faults, and R2-put faults never create an
  `available` version, and content errors keep the version `uploading` for a
  grant reissue (`docs/work-packages/evidence/WP-V01/fault-matrix.md`,
  `tools/artifacts/run.ts`, mounted worker tests).
- Same-hash concurrent publication never overwrites bytes and may back
  distinct logical versions (SG-03; harness `same_hash_race_converged` plus
  the domain convergence tests in `packages/domain/test/artifacts.test.ts`).
- Only available versions can be referenced downstream: re-grants refuse
  terminal versions, and view grants (V02) plus reviews (V03) refuse
  non-`available` versions (`docs/contracts/artifacts.md`, the V02/V03
  domain tests, and the V02 hostile corpus).
- R2 keys are derived server-side and remain workspace-prefixed; callers
  never select a key and responses carry none
  (`packages/domain/test/artifacts.test.ts`, Go client error mapping).
- Raw upload secrets exist only once and are never logged or stored
  plaintext: only the creation/issuance response carries the secret, while
  D1, events, idempotency records, and rate keys keep hashes only
  (`docs/contracts/artifacts.md`, harness secret-retention scan).
- Lost-grant recovery reissues a grant for an `uploading` version and
  converges receipts; abandoned versions are swept to `failed` without
  deleting shared bytes.
- Upload-grant budgets survive Worker-isolate changes (21st pinned-IP upload
  attempt fails closed; the spared grant redeems from a fresh IP).
- Run-scoped MCP/CLI/daemon derives current authority, reads one pinned
  bounded immutable snapshot, performs fixed prepare/upload/finalize phases,
  and returns no credential, origin, local path or R2 key. Explicit same-ID
  retry after lost replies and MCP/daemon restart resolves one canonical
  operation; changed input or lost authority cannot expose a private result.
- Cron scans are bounded and read-only; fresh system Hub commands protect
  regrants and in-flight consumed grants until expiry plus grace. Original
  audit-outbox IDs bind atomic, redacted event/audit projection and stamping
  despite concurrent dispatch, late failure or transient reply-cache loss.
- Exact gate from a clean checkout: `pnpm test:v01` passes; evidence
  manifest committed with the tested commit hash.

## Evidence

- `docs/work-packages/evidence/WP-V01/manifest.json` (schema-conformant):
  `command-result.json` (install, build, `test:v01`, `verify`,
  `worktree:check` outcomes for the tested commit),
  `fault-matrix.md` (every acceptance bullet mapped to its failing-first
  proof), `docs/contracts/artifacts.md`, migration 0020, domain/worker/
  route/harness/Go sources listed as artifacts.
- `pnpm test:v01` output ends with `V01_D1_OK` (harness) and green Go race
  tests; no secret, grant, byte, or local-path content in evidence.

## Risks and decisions

- Risk: two workers racing the same content hash could double-write R2.
  Decision: content-addressed conditional create (`onlyIf:
  etagDoesNotMatch: *` with verified `sha256`) plus the D1 object registry;
  the loser verifies instead of overwriting (race test in harness).
- Risk: plaintext grant secrets persisting through hub idempotency records.
  Decision: routes mint secrets and pass only hashes into commands; results
  and audit payloads carry hashes (capability-scan test in harness).
- Risk: D1 batches cannot read after a queued write. Decision: all reads
  precede writes in every command/helper; the single-consume fence is a
  guarded update plus a mutating-guard row (domain tests + harness replay).
- Risk: the historical transport-free `ToolDefinition`/`InvokePublish` seam
  was mistaken for local integration. The registration in
  `apps/control-worker/src/mcp/server-factory.ts` is delegated remote OAuth,
  not local native-run authority; the local Host currently rejects publication.
  Current V01 owns the missing connected local path and its acceptance.

## Handoff

- Runtime integration active 6 October after A04 certification at `a7a763c`.
  Required A01/C01/C04/F03 packages are `done`. Reproduced or code-confirmed
  gaps include restricted-project regrant/finalize access, timestamp-based
  consume correlation, ignored R2 conditional `null`, absent local MCP
  publication and incompatible historical browser-auth client assumptions.
  Direct upload-grant consumption is an explicit architecture exception;
  immutable upload bookkeeping and audit projection need precise documentation.
  No new V01 runtime acceptance or downstream certification is claimed yet.
- Dependency hold, 5 October: A01 is reopened for its missing production online/replay path. This implementation and historical isolated acceptance are retained; their tests have not been declared failed. Re-certification and settlement wait for A01 runtime acceptance and affected integration checks. The dated status below is historical, not the current package state.
- Settled 18 September: `done`. A01 is `done`, and `pnpm test:v01` passed in a detached clean checkout at `9372c0f` (install, build, exact target ending `V01_D1_OK` with Go race tests).
- Run `pnpm test:v01` (toolchain: Node 24.19.0, pnpm 11.21.0, Go 1.26.5;
  browser tests use `BFB_E2E_PORT=4176`; V01 needs none; Worker ports are
  ephemeral via the wrangler harness — 8787/8788 untouched).
- Deploy wiring: Artifact Worker needs the shared D1 binding plus
  `wrangler secret put UPLOAD_ABUSE_SECRET` on staging/production (uploads
  fail closed without it); control Cron sweeps abandoned uploads every 5
  minutes via `runArtifactSweep`.
- Current local integration follows ADR 0010's closed v6 capability, not the
  old `internal/artifact.ToolDefinition()`/`Client.InvokePublish` seam.
  X02 remains held: browser publication routes do not accept human CLI
  credentials, and bound native-run authority cannot substitute for them.
- Limitations: no view path (V02), no retention delete, sweep marks
  versions `failed` but never removes shared bytes, oversized/rejected
  uploads consume their grant (reissue to retry).

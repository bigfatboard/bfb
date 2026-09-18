# WP-V01 — Artifact storage state machine

Status: `done`

> Settled 18 September: `done` — A01 is `done` and `pnpm test:v01` passed in
> a detached clean checkout at `9372c0f`; see Handoff.

Risk: High

Test target: `pnpm test:v01`

Evidence manifest: `docs/work-packages/evidence/WP-V01/manifest.json`

## Outcome

An authorized human can publish a bounded review artifact or compressed log
chunk through typed create → upload → finalize calls backed by real Workers,
D1, and R2, and A01 can register the same publish flow as a run-scoped MCP
tool.

## Dependencies

- **Requires:** A01, C01, C04, F03.
- **Unlocks:** V02, X02, X03, X05.
- **Can run with:** L01, P01.

## Scope

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
- D1 migration `0020_artifact_storage` (manifest head `0020_artifact_storage`)
  with single-claim guards, immutable history, upload receipts, the
  content-addressed object registry, and the audit outbox.
- Typed Go create → upload → finalize client plus CLI (`bfb artifact
  publish`) and daemon (`artifact.publish`) entry points, exposed for A01 to
  register as an MCP tool; local-RPC wire contract and fixtures included.
- Acceptance harness `tools/artifacts/run.ts` proving every bullet against
  real Workers, D1, and disposable R2, with fault injection at every D1/R2
  boundary.

## Non-goals

- Artifact views, renderers, and review surfacing (V02/V03 own them; no
  viewer, renderer, or review work happened here).
- Retention, lifecycle deletion, and client-supplied storage keys.
- CLI-credential auth on publication routes (X02) and run-scoped agent
  authority (A01 registers it against these same commands).

## Contracts

### Consumes

- `docs/contracts/workspace-hub.md` — every workspace mutation serializes
  through `WorkspaceHub`; Cron recovery uses the system actor.
- C01 `WorkspaceHub`/durable abuse controls and C04 authorization
  (`packages/domain`: principal load, role/epoch fences, budget buckets).
- F03 Artifact Worker + R2 substrate (`apps/artifact-worker`,
  `tools/substrate`): cookie-less origin, private bucket, Cron discipline.
- D1 layer and migration chain (`packages/db`, `migrations/d1`,
  manifest head `0020_artifact_storage`).
- Local-RPC envelope (`protocol/schema/v1/local-rpc.json`): V01 declares the
  `artifact.publish` payload keys, dispatch entries, and `v01-publish`
  fixtures (minimal integration point, regenerated bindings committed).

### Produces

- `docs/contracts/artifacts.md` (frozen): state machine, grant rules,
  routes, R2 key layout, formats/limits, Go client errors, local-RPC
  payload, and the `bfb_publish_artifact` MCP seam for A01.
- `pnpm test:v01`: domain unit tests, mounted worker/route tests, the
  real-Worker acceptance harness, protocol gate, and Go race tests.
- `docs/work-packages/evidence/WP-V01/manifest.json`: bounded, redacted
  evidence for the tested commit.

## Work plan

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
- Lost-grant recovery reissues a grant for an `uploading` version and
  converges receipts; abandoned versions are swept to `failed` without
  deleting shared bytes.
- Upload-grant budgets survive Worker-isolate changes (21st pinned-IP upload
  attempt fails closed; the spared grant redeems from a fresh IP).
- Run-scoped MCP/CLI/daemon client consumes authorization, runs typed
  create → upload → finalize, and never selects an R2 key or emits secrets
  (`internal/artifact`, `bfb artifact publish`, `artifact.publish`,
  `bfb_publish_artifact` seam for A01).
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
- Risk: A01 (MCP registration) is in flight. Decision: V01 ships the typed
  client plus a transport-free `ToolDefinition`/`InvokePublish` seam and
  stays at `planned` until A01 lands (roadmap rule).

## Handoff

- Settled 18 September: `done`. A01 is `done`, and `pnpm test:v01` passed in a detached clean checkout at `9372c0f` (install, build, exact target ending `V01_D1_OK` with Go race tests).
- Run `pnpm test:v01` (toolchain: Node 24.19.0, pnpm 11.21.0, Go 1.26.5;
  browser tests use `BFB_E2E_PORT=4176`; V01 needs none; Worker ports are
  ephemeral via the wrangler harness — 8787/8788 untouched).
- Deploy wiring: Artifact Worker needs the shared D1 binding plus
  `wrangler secret put UPLOAD_ABUSE_SECRET` on staging/production (uploads
  fail closed without it); control Cron sweeps abandoned uploads every 5
  minutes via `runArtifactSweep`.
- A01 seam: register `internal/artifact.ToolDefinition()`
  (`bfb_publish_artifact`) on the run-scoped server and call
  `Client.InvokePublish`; scope `path` to the calling run first — results
  never carry the grant secret. X02 seam: publication routes currently take
  browser sessions only; designate CLI-credential auth there when X02 lands.
- Limitations: no view path (V02), no retention delete, sweep marks
  versions `failed` but never removes shared bytes, oversized/rejected
  uploads consume their grant (reissue to retry).

# Release contract (WP-G02)

Status: frozen for v0.1. Changes require a work package and a contract revision.

G02 owns the release surface: the tagged release manifest, per-environment
resource inventory, provenance and inventory (SBOM), deployment job split,
migration and rollback limits, the signed macOS artifact, secret and key
rotation, and the clean-environment gate procedures. G02 changes no domain
behavior owned by another package; it packages and proves the same binary
the feature packages certified.

## Release identity

A BFB v0.1 release is identified by a tag `v0.1.<n>` on the exact commit
recorded in the release manifest, plus the four frozen heads from
`release-candidate.md`:

| Head | Value | Source of truth |
| --- | --- | --- |
| Wire protocol | `bfb-wire/1` | `packages/protocol-ts/src/generated/types.ts` (`PROTOCOL_HEAD`) |
| Contract schema | `1` | `packages/protocol-ts/src/generated/types.ts` (`SCHEMA_VERSION`) |
| D1 migrations | `0034_operations` | `migrations/d1/manifest.json` (`migration_head`) |
| CLI API | `1` / `bfb-wire/1` / min CLI `0.1.0` | `apps/control-worker/src/api/cli-human.ts` |

Pinned providers and auth stay as frozen in `release-candidate.md`
(Claude `2.1.275`, Codex `0.153.4`, Grok `1.0.34`, Better Auth `1.6.26`).
`pnpm test:g02` asserts the four heads before any install, upgrade, or
recovery drill, following the G02 entry procedure in `release-candidate.md`.

## Environment inventory

Four environments exist. Each owns separate D1, R2, Queue, DLQ, Durable
Object namespace, OAuth, key, and secret resources. Names are pairwise
distinct across environments; `pnpm test:g02` parses every committed
wrangler config and fails on any shared database name, database id, bucket,
queue, or worker name.

| Resource | Local | Staging | Managed production | Self-host |
| --- | --- | --- | --- | --- |
| Control worker | `bfb-control-local` | `bfb-control-staging` | `bfb-control` | `bfb-control-selfhost` |
| Artifact worker | `bfb-artifact-local` | `bfb-artifact-staging` | `bfb-artifact` | `bfb-artifact-selfhost` |
| D1 database | `bfb-local` | `bfb-staging` | `bfb` | `bfb-selfhost` |
| R2 bucket | `bfb-artifacts-local` | `bfb-artifacts-staging` | `bfb-artifacts` | `bfb-artifacts-selfhost` |
| Queues / DLQs | `bfb-{jobs,notify,ops}-local` (+`-dlq`) | `bfb-{jobs,notify,ops}-staging` (+`-dlq`) | `bfb-{jobs,notify,ops}` (+`-dlq`) | `bfb-{jobs,notify,ops}-selfhost` (+`-dlq`) |
| Durable Object | `WorkspaceHub` (sqlite) | `WorkspaceHub` (sqlite) | `WorkspaceHub` (sqlite) | `WorkspaceHub` (sqlite) |
| Config files | `wrangler.toml` | `wrangler.staging.toml` | `wrangler.production.toml` | `wrangler.selfhost.toml` |

Local, staging, and production configs are owned by F03. The self-host
configs (`apps/control-worker/wrangler.selfhost.toml`,
`apps/artifact-worker/wrangler.selfhost.toml`) are owned by G02 and ship
with operator-replaced origins (`https://bfb.selfhost.example.test` and
siblings) and operator-created resource ids. No committed config contains a
production secret value; secrets are set with `wrangler secret put` during
the separately confirmed rollout, never in G02.

## Jurisdiction gate

Every control config sets `JURISDICTION`. Managed production is pinned to
`eu`. The self-host config ships `JURISDICTION = "choose"`, which fails
`validateControlEnv` (`invalid jurisdiction`) so the worker refuses to boot
until the operator records `eu`, `us`, or `global`. One deployment serves
one jurisdiction; mixed per-workspace jurisdiction in one deployment is a
non-goal. `pnpm test:g02` proves the gate both ways: the sentinel fails
closed and each of `eu`/`us`/`global` validates.

## Deployment jobs

`.github/workflows/release.yml` defines four sequential jobs against a
protected `managed-production` environment (manual approval, EU runner):

1. `build-test` — install, `pnpm verify`, `pnpm test:g02`.
2. `migrate` — apply `migrations/d1` to the target D1 (empty or
   previous-release start), then run the migration matrix check.
3. `publish` — `wrangler deploy` for the control and artifact workers.
4. `smoke` — the post-deploy smoke in `docs/release/rollout.md`, which
   exercises authenticated handlers (`/healthz`, `/api/v1/cli/version`,
   credential-rejected routes), never just CI or deploy success.

G02 validates the same configs and the same worker entry points without
touching a remote account: `wrangler deploy --dry-run --outdir` for every
staging, production, and self-host config, plus the authenticated-handler
smoke against the real worker bundle on local fixtures. Preparation creates
no managed-production resource and performs no production deployment.

## Migration and data safety

Migrations are forward-only and expand-contract: additive statements
(`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN`) plus the
reviewed dependency-closed table rebuilds established by F04 (for example
`0006_reviewer_role`, `0007_tenant_relationships`), where a `DROP TABLE`
appears only inside a migration that recreates the table in the same file.
There is no down-migration path. `pnpm test:g02` scans every migration for
`DROP`/`DELETE` outside that rebuild shape and fails on any new one.

OG-02 drills, on local fixtures, an empty start and a previous-release
start (seeded at `0004_human_credentials` per
`packages/db/test/fixtures/previous-schema.json`) through head
`0034_operations`, asserting both converge on the same schema with fixture
rows preserved and foreign keys clean.

Before any destructive step the operator captures D1 Time Travel or an
export; the procedure is `docs/release/migration-rollback.md`. Worker
(publication) rollback is not database rollback:

| Change | Worker rollback | Data rollback |
| --- | --- | --- |
| Worker code only, same migration head | Redeploy the previous worker bundle | Not needed |
| Worker code with a new forward-only migration | Redeploy the previous worker bundle only if it tolerates the newer schema; otherwise forward-repair | Never automatic; Time Travel/export restore, then forward-repair |
| Incompatible Durable Object change | Cannot be gradually mixed; single-version cutover | Same as above |

Durable Object lifecycle constraints: `WorkspaceHub` uses sqlite storage,
there are no `[[migrations]]` gradual-rollout blocks in any committed
config (asserted by `wrangler-config.test.ts` and `pnpm test:g02`), and an
incompatible DO change ships as a new class with a cutover plan, never as
an in-place gradual mix.

## macOS release artifact

The release artifact is the development-signed `.app` bundle built by
`node tools/macos/build.mjs` with its embedded Go helper. Frozen
identities and paths:

| Fact | Value | Proved by |
| --- | --- | --- |
| App identifier | `com.qdis.bfb` | signed bundle, `pnpm test:g02` |
| Helper identifier | `com.tenira.bfb.daemon` | signed helper, `pnpm test:g02` |
| Stable hook launcher path | `Contents/Helpers/bfb` with `__launch <terminal-intent-uuid>` | `NativeActions.swift`, signed bundle layout |
| Self-host wake scheme | `bfb://launch/<cloud-wake-ULID>` (512-byte bound) | `Info.plist` `CFBundleURLSchemes`, `macos-app.md` |
| Managed wake links | `https://<associated-host>/l/<cloud-wake-ULID>` | Associated Domains entitlement + `BFB_MACOS_PROFILE` |
| Daemon service label | `com.tenira.bfb.daemon` | `internal/daemon/install.go` |

Upgrade preserves Keychain items (CLI `bfb-cli`, runner keys, provider
credentials keep their services, accounts, and access groups), the daemon
database and locks, Universal Link handling, hooks, and recovery markers,
because upgrade replaces only the bundle at its stable location while
identifiers stay fixed. Uninstall removes the bundle and the launchd plist
and never deletes Keychain items, the daemon database, or audit history
without an explicit operator backup. Notarization is a prepared,
documented rollout step (`docs/release/rollout.md`); G02 builds and signs
locally with the development profile and does not notarize.

## Golden flow

The release golden flow, in order, is: clean install, first-owner
bootstrap (consumes once; never promotes the first ordinary signer-in),
runner enrollment, checkout link, provider setup, launch, realtime,
attention, result, artifact review, then uninstall or upgrade behavior.
`pnpm test:g02` drives every stage on local fixtures (real worker bundle,
local D1, isolated daemon state, synthetic identities) and the browser spec
on `BFB_E2E_PORT=4198` proves the board, attention, and review surfaces
render. The blank-account and blank-Mac passes of the same flow are AG-10
and stay `not_run` until the clean environments exist.

## Secrets and key rotation

Secret inventory (no values are committed; rotation never renames the
binding):

| Secret | Store | Rotation path |
| --- | --- | --- |
| `BETTER_AUTH_SECRETS` | Worker secret | Set overlap value, deploy, remove retired value |
| `AUTH_ABUSE_SECRET` | Worker secret | Same overlap procedure; abuse budgets re-key |
| `GITHUB_WEBHOOK_SECRET` | Worker secret + GitHub app | Same overlap procedure, then GitHub app |
| `GITHUB_APP_PRIVATE_KEY` | Worker secret | New GitHub key, overlap, retire old |
| `VAPID_PRIVATE_KEY` (+ public, subject) | Worker secret | New pair, overlap, retire old |
| `UPLOAD_ABUSE_SECRET` (artifact worker) | Worker secret | Same overlap procedure |
| Runner P-256 keys (per workspace) | Daemon Keychain, daemon-owned ACL | Re-enroll the runner; revocation fences the old key first |
| CLI `bfb_cli_` credentials | Keychain item `bfb-cli`, hash-only server row | Revoke the binding, approve a fresh device flow |
| Provider credentials | Provider-native stores | Provider setup/doctor per L03/L07/P01/P02 |

Rotation uses current/previous `kid` overlap: verifiers accept the current
and the previous key id during the overlap window, new signatures mint
under the current id, and the previous id retires only after the overlap
proves clean. `pnpm test:g02` drills the overlap state machine on
synthetic keys (current accepts, previous accepts during overlap, unknown
rejects, retired previous rejects) and asserts the operations health
rotation signal (`TOKEN_ROTATION_WARN_MS` in `packages/domain/src/operations.ts`)
still flags runner tokens expiring within 24h. The operator procedure is
`docs/runbooks/key-rotation.md`.

## Provenance and inventory

The release manifest (`docs/work-packages/evidence/WP-G02/release-manifest.json`)
records the tag, tested commit, frozen heads, per-environment resource
names parsed from the committed configs, toolchain pins, and provider pins.
The SBOM (`sbom.json`) inventories workspace components with versions plus
pinned external toolchain, with SHA-256 over each release input
(wrangler configs, migration manifest, this contract, the release
workflow). Provenance (`provenance.json`) records the producing commands
and input hashes. Generated evidence embeds no timestamps or generated
ids, so `pnpm test:g02` regenerates it byte-identically.

## Clean-environment gates

AG-10 (blank Cloudflare account, blank Mac, first-owner bootstrap,
provider flow, artifact review, upgrade/recovery smoke) and OG-02
(empty/previous migrations, key overlap, Worker/data rollback decision
trace) run from tagged release artifacts in clean environments per
`docs/release/clean-install.md` and `docs/release/migration-rollback.md`.
Until those environments exist both gates stay `not_run` with the exact
reason recorded; they are never marked passed by local fixtures and never
simulated.

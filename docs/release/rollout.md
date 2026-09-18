# Managed rollout, smoke, and rollback

This is the separately confirmed managed-production rollout. G02 prepares
and dry-runs everything here; nothing here runs without Timo's explicit
rollout confirmation. The release contract is
[../contracts/release.md](../contracts/release.md).

## Rollout options

| Option | When | Command spine |
| --- | --- | --- |
| A. Staging first | Default. Prove the tagged release on staging, then promote the same tag to production. | `.github/workflows/release.yml` against staging, then `managed-production` |
| B. Self-host pilot | An operator-owned account goes first using [../self-host.md](../self-host.md). | Self-host guide, then option A |
| C. Production direct | Only when staging and self-host already pass on the same tag. Requires explicit confirmation naming this option. | `release.yml` with `managed-production` approval |

Production stays on jurisdiction `eu`. The `JURISDICTION` var is passed
explicitly at publish time; the self-host sentinel (`choose`) never
reaches production configs.

## Pre-flight (local, offline)

```sh
git checkout v0.1.<n>
pnpm install --frozen-lockfile
pnpm verify
pnpm test:g02
pnpm exec wrangler deploy --dry-run --outdir /tmp/bfb-dry-run-control --config apps/control-worker/wrangler.production.toml
pnpm exec wrangler deploy --dry-run --outdir /tmp/bfb-dry-run-artifact --config apps/artifact-worker/wrangler.production.toml
```

Dry runs bundle locally and create nothing remotely.

## Smoke commands

After publish, against the production origin:

```sh
node tools/g02/smoke-commands.mjs --origin https://bfb.example.test
```

The smoke asserts `/healthz` reports `ok` with worker-first routing,
`/api/v1/cli/version` keeps its frozen shape, and CLI session routes
reject missing and bad credentials with `401`. Green CI or a successful
deploy never substitutes for this smoke.

## Notarization (prepared step)

The Mac release artifact is built and development-signed locally by
`node tools/macos/build.mjs`. Notarization runs at rollout time:

```sh
xcrun notarytool submit BFB.app --wait
xcrun stapler staple BFB.app
codesign --verify --deep --strict --verbose=2 BFB.app
```

Notarization needs Apple credentials and network access, so G02 records it
as a documented step, not local evidence.

## Rollback and forward-repair decision tree

1. Publish fails, D1 untouched: fix forward, republish. No data step.
2. Publish succeeds, smoke fails, no new migration: redeploy the previous
   worker bundle. No data step.
3. A new forward-only migration applied, previous worker tolerates the
   newer schema: redeploy the previous worker bundle, then forward-repair.
4. A new migration applied, previous worker does not tolerate it: do not
   roll the worker back alone. Restore D1 from the pre-release Time Travel
   or export, redeploy the matching worker bundle, then forward-repair.
5. Incompatible Durable Object change: single-version cutover only;
   gradual mixing is unsupported and untested.

Worker rollback is never database rollback. The full matrix is
[../contracts/release.md](../contracts/release.md) with the executable
drill in [migration-rollback.md](migration-rollback.md).

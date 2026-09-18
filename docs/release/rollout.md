# Managed rollout, smoke, and rollback

This is the separately confirmed managed-production rollout. G02 prepares
and dry-runs everything here; nothing here runs without Timo's explicit
rollout confirmation. The release contract is
[../contracts/release.md](../contracts/release.md).

## One-time repository setup

The workflow file alone creates no approval gate: the `staging` and
`managed-production` GitHub environments and every secret below are
created once in the repository settings before the first rollout.
Until this setup exists there is no approval step, so production must
not be targeted.

- Environments: create `staging` (no reviewers) and
  `managed-production` with required reviewers (Timo plus the release
  captain of the day). The workflow selects the environment from its
  `target` input; reviewers enforce the human approval.
- Secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (the
  Cloudflare account that owns the target resources),
  `BFB_MACOS_PROFILE_B64` (base64 of the Mac development profile for
  `com.qdis.bfb`, the file `BFB_MACOS_PROFILE` points to locally),
  `BFB_MACOS_SIGNING_P12_B64` (base64 of the Apple Development signing
  certificate) with `BFB_MACOS_SIGNING_P12_PASSWORD` (its import
  password). The gate jobs materialize the profile and import the
  certificate into a throwaway keychain at run time.

## Rollout options

| Option | When | Command spine |
| --- | --- | --- |
| A. Staging first | Default. Prove the tagged release on staging, then promote the same tag to production. | Dispatch `release.yml` with `target: staging`, then again with `target: production` and `confirm_tag` equal to the tag |
| B. Self-host pilot | An operator-owned account goes first using [../self-host.md](../self-host.md). | Self-host guide, then option A |
| C. Production direct | Only when staging and self-host already pass on the same tag. Requires explicit confirmation naming this option. | Dispatch `release.yml` with `target: production`, `confirm_tag` equal to the tag, and the `managed-production` approval from the setup above |

Production stays on jurisdiction `eu`. The `JURISDICTION` var is passed
explicitly at publish time; the self-host sentinel (`choose`) never
reaches production configs.

## Pre-flight (local, offline)

The gate needs its Mac signing prerequisites on the machine that runs
it: the pinned Xcode (see `.xcode-version`), an Apple Development
signing identity in the keychain, and `BFB_MACOS_PROFILE` pointing at
the development profile for `com.qdis.bfb` (see
[clean-install.md](clean-install.md)). Without them `pnpm test:g02`
fails at the signing proof, not at the code under test.

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

After publish, against the deployed origin (substitute the real
control-worker host; the pipeline takes it as its `origin` input):

```sh
node tools/g02/smoke-commands.mjs --origin https://bfb.<operator-host>
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

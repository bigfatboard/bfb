# BFB v0.1 self-host guide

This guide installs BFB on an operator-owned Cloudflare account and an
operator-owned Mac. Every step runs from this repository; there are no
hidden dashboard or manual prerequisites beyond creating the account,
installing the pinned toolchain, and choosing a jurisdiction.

Coordinate system: the release contract is
[docs/contracts/release.md](contracts/release.md). The rollout,
rollback, and clean-install procedures are
[docs/release/rollout.md](release/rollout.md),
[docs/release/migration-rollback.md](release/migration-rollback.md), and
[docs/release/clean-install.md](release/clean-install.md).

## 0. Prerequisites

- A Cloudflare account with Workers, D1, R2, Queues, and Durable Objects.
- The pinned toolchain: Node `24.19.0`, pnpm `11.21.0`, Go `1.26.5`,
  Xcode `26` (see `.node-version`, `.go-version`, `.xcode-version`).
- A macOS Mac for the runner. Managed Universal Links additionally need a
  Mac provisioning profile for `com.qdis.bfb` with Associated Domains.
- One jurisdiction choice for the whole deployment: `eu`, `us`, or
  `global`. Mixed per-workspace jurisdiction in one deployment is not
  supported.

## 1. Prepare the repository

```sh
git checkout v0.1.<n>
corepack enable && corepack install
pnpm install --frozen-lockfile
pnpm verify
pnpm test:g02
```

## 2. Copy the self-host configs

```sh
cp apps/control-worker/wrangler.selfhost.toml apps/control-worker/wrangler.operator.toml
cp apps/artifact-worker/wrangler.selfhost.toml apps/artifact-worker/wrangler.operator.toml
```

Edit the operator copies (never commit them): set `JURISDICTION` to the
choice from step 0, replace the three `*.selfhost.example.test` origins
with operator-owned hosts (app, artifact, and launch hosts must differ),
and keep every resource name distinct from any other environment.

## 3. Create resources

```sh
pnpm exec wrangler d1 create bfb-selfhost
pnpm exec wrangler r2 bucket create bfb-artifacts-selfhost
pnpm exec wrangler queues create bfb-jobs-selfhost
pnpm exec wrangler queues create bfb-jobs-dlq-selfhost
pnpm exec wrangler queues create bfb-notify-selfhost
pnpm exec wrangler queues create bfb-notify-dlq-selfhost
pnpm exec wrangler queues create bfb-ops-selfhost
pnpm exec wrangler queues create bfb-ops-dlq-selfhost
```

Write the returned D1 id into both operator configs as `database_id`.
Nothing is created implicitly: if a name is missing here, deploy fails
instead of provisioning it.

## 4. Set secrets

```sh
pnpm exec wrangler secret put BETTER_AUTH_SECRETS --config apps/control-worker/wrangler.operator.toml
pnpm exec wrangler secret put AUTH_ABUSE_SECRET --config apps/control-worker/wrangler.operator.toml
pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET --config apps/control-worker/wrangler.operator.toml
pnpm exec wrangler secret put GITHUB_CLIENT_ID --config apps/control-worker/wrangler.operator.toml
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET --config apps/control-worker/wrangler.operator.toml
pnpm exec wrangler secret put VAPID_PUBLIC_KEY --config apps/control-worker/wrangler.operator.toml
pnpm exec wrangler secret put VAPID_PRIVATE_KEY --config apps/control-worker/wrangler.operator.toml
pnpm exec wrangler secret put VAPID_SUBJECT --config apps/control-worker/wrangler.operator.toml
pnpm exec wrangler secret put UPLOAD_ABUSE_SECRET --config apps/artifact-worker/wrangler.operator.toml
```

Rotation afterwards follows [docs/runbooks/key-rotation.md](runbooks/key-rotation.md).

## 5. Export, migrate, publish, smoke

```sh
pnpm exec wrangler d1 export bfb-selfhost --remote --output ./bfb-pre-v0.1.<n>.sql --config apps/control-worker/wrangler.operator.toml
pnpm exec wrangler d1 migrations apply bfb-selfhost --remote --config apps/control-worker/wrangler.operator.toml
pnpm exec wrangler deploy --config apps/control-worker/wrangler.operator.toml
pnpm exec wrangler deploy --config apps/artifact-worker/wrangler.operator.toml
node tools/g02/smoke-commands.mjs --origin https://bfb.<operator-host>
```

The smoke exercises authenticated handlers, not just deploy success. If
any step fails, stop and follow
[docs/release/rollout.md](release/rollout.md); Worker rollback is not
database rollback.

## 6. First owner and Mac runner

1. Open the app origin and complete first-owner bootstrap once. A second
   bootstrap and the first ordinary signer-in never gain ownership.
2. Build the Mac app with `node tools/macos/build.mjs`, move the bundle to
   its stable location, and run **Start runner**. The daemon installs under
   the per-user label `com.tenira.bfb.daemon`.
3. Enroll the runner in the browser, link the checkout, run provider setup
   and doctor, then complete the golden flow in
   [docs/contracts/release.md](contracts/release.md): launch, realtime,
   attention, result, artifact review.
4. Upgrades replace only the bundle at its stable location; Keychain
   items, the daemon database, hooks, and recovery markers persist because
   identifiers never change.

Incidents follow [docs/runbooks/incident-recovery.md](runbooks/incident-recovery.md).

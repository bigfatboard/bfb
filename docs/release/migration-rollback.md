# OG-02 executable procedure: migrations, rotation, and rollback limits

Gate OG-02 claims empty and previous-release migrations, key rotation,
deployment, rollback limits, and forward repair are reproducible.

Status: `not_run` for the clean-environment halves. The local drills
(empty start, previous-release start, expand-contract audit, dual-`kid`
overlap, Worker/data rollback decision trace) run offline in
`pnpm test:g02` and are proven. The Time Travel restore and the
cross-release upgrade passes below need a real D1 with Time Travel or
exports plus two consecutive release tags, so they run at rollout time and
stay `not_run` until then.

## Local drills (proven by `pnpm test:g02`)

- Empty start: apply all of `migrations/d1` to a fresh database, assert
  head `0034_operations`, foreign keys clean.
- Previous-release start: seed at `0004_human_credentials` per
  `packages/db/test/fixtures/previous-schema.json`, apply through head,
  assert the same schema with fixture rows preserved.
- Expand-contract audit: every migration is additive or one of the
  reviewed F04 dependency-closed table rebuilds; no other `DROP` or
  `DELETE` exists.
- Key overlap: synthetic current/previous `kid` verification accepts both
  during overlap, rejects unknown ids, and rejects the previous id after
  retirement.
- Rollback decision trace: Worker-only, Worker-plus-migration, and
  incompatible-DO cases resolve per the matrix in
  [../contracts/release.md](../contracts/release.md); incompatible DO
  changes never mix gradually.

## Pre-destructive safety (rollout time)

Before any migration that rebuilds a table or any manual data repair:

```sh
pnpm exec wrangler d1 export bfb --remote --output ./bfb-pre-<tag>.sql --config apps/control-worker/wrangler.production.toml
```

D1 Time Travel on the same database is an equivalent backstop. Record
which backstop was captured; a destructive step without one fails the
gate.

## Cross-release upgrade (rollout time)

1. Deploy tag N on the target environment and record the migration head.
2. Capture the backstop above.
3. Deploy tag N+1 through `.github/workflows/release.yml`
   (build-test, migrate, publish, smoke).
4. Prove the previous-release start converges: schema snapshot matches the
   empty-start snapshot at the new head, server rows survive, foreign keys
   clean.
5. If step 3 fails after a migration applied: do not roll the worker back
   alone unless the previous worker tolerates the newer schema. Restore
   from the backstop or forward-repair, then republish and re-run the
   smoke in [rollout.md](rollout.md).

## Evidence

Drill output ships in `docs/work-packages/evidence/WP-G02/`
(`migration-drill.json`, `rotation-drill.json`, `rollback-limits.json`).
Rollout-time passes append the backstop record, both heads, the schema
comparison, and the decision taken to the acceptance table in
`docs/work-packages/WP-G02-release-self-host.md`.

# WP-D03 local runtime: start, stop, health

Local MVP discussion surface: the synthetic browser stack on one Mac
(`tools/e2e/src/server.ts` serves the web UI, the control API, and the
synthetic runner hooks). No provider credentials are used; every turn is a
synthetic D01/D02-committed record.

## Start

```sh
pnpm install --frozen-lockfile
pnpm build
BFB_E2E_PORT=4191 pnpm exec tsx tools/e2e/src/server.ts
```

Open `http://bfb.localhost:4191` in Chromium and sign in with the owner
fixture. The D03 seed provides four task cards:

- `Synthetic discussion exchange card` — concluded six-turn exchange.
- `Synthetic discussion intervention card` — active with one intervention.
- `Synthetic discussion stopped card` — cancelled.
- `Synthetic discussion empty card` — no discussions; start form only.

To run the full gate instead of browsing manually:

```sh
pnpm test:mvp-discussion
```

## Stop

The foreground server stops with Ctrl-C. No background processes, queues, or
locks remain: state is an in-memory SQLite database per server run, so
stopping discards everything. Remove a detached worktree only with
`git worktree remove --force <path>` after its server has exited.

## Health

- `GET /healthz` returns `ok` with the seeded workspace id.
- `GET /__test/session/owner` mints the owner fixture session (302).
- `GET /__test/d03/task` returns the seeded D03 task and discussion ids.
- `GET /api/v1/workspaces/<id>/tasks/<task>/discussions?limit=50` lists
  committed discussions for a task.
- A live browser socket (`bfb.browser.v1`) ends with `ready`; every
  committed command invalidates subscribers by cursor.

## Live providers

Live Claude/Codex turns are out of scope here: supervised launches on this
Mac are not certified until L05 lands, and no provider credentials or
consent exist in this environment. The live smoke is scripted but gated:

```sh
BFB_LIVE_SMOKE=1 BFB_DISCUSSION_SMOKE_BASE=<control-origin> \
  BFB_DISCUSSION_SMOKE_TASK=<task-id> BFB_DISCUSSION_SMOKE_COOKIE=<owner-cookie> \
  node tools/discussion-smoke/smoke.mjs
```

Without `BFB_LIVE_SMOKE=1` (and L05 done) the script exits non-zero and
prints the pending requirements instead of faking a result.

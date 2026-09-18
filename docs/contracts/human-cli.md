# Human CLI parity v1

Owner: [X02](../work-packages/WP-X02-human-cli.md). Gate: `pnpm test:x02`.

This contract freezes the human CLI surface: the command-to-owner matrix,
the JSON envelope, the exit-code taxonomy, credential separation, explicit
destructive-action gating, generated help/completion, version diagnostics,
and per-command offline behavior. G02 packages the same binary; it does not
fork CLI behavior.

No D1 migration belongs to X02. The assembler owns no domain mutation: every
CLI write forwards to a domain command owned by its feature package, and
`apps/control-worker/src/api/cli-human.ts` contains no direct table writes.

## Command-to-owner matrix

Every path is registered by exactly one owner. `internal/humancli.Table`
is the machine source; `internal/humancli` tests fail on a missing owner, a
duplicate owner, or a summary drift against the live registry.

| Command | Owner | Notes |
| --- | --- | --- |
| `login`, `logout`, `whoami` | C05 | Device flow, self-revocation, session projection |
| `daemon run`, `daemon status`, `daemon stop`, `daemon logs`, `daemon install` | L01 | Local Unix-socket clients, unchanged by X02 |
| `runner enroll`, `runner list`, `runner wake`, `runner forget` | L08 | Local enrollment clients, unchanged by X02 |
| `checkout link`, `checkout list`, `checkout verify`, `checkout unlink` | L02 | Local registry clients, unchanged by X02 |
| `provider setup claude`, `provider doctor claude` | L07 | Local adapter clients; P01/P02 mirror for Codex/Grok |
| `project list`, `project get` | C07 | Thin reads over `GET /api/v1/cli/projects*` |
| `task list`, `task get`, `task create` | C08 | Thin clients over `GET/POST /api/v1/cli/tasks*` |
| `run list`, `run get` | C08 | Thin reads mirroring the browser run columns |
| `run submit` | A03 | Run-scoped agent submission, unchanged by X02 |
| `run cancel` | C08 | Guarded write over `POST /api/v1/cli/runs/:id/cancellation` |
| `attention list`, `attention get`, `attention answer`, `attention resolve` | A02 | Thin clients over `/api/v1/cli/attention*` |
| `hook ingest`, `hook status` | L06 | Local journal clients, unchanged by X02 |
| `mcp stdio` | A01 | Run-scoped server, unchanged by X02 |
| `artifact publish` | V01 | Local file-based publish, unchanged by X02 |
| `artifact list`, `artifact get` | V01 | Metadata reads over `/api/v1/cli/artifacts*`; bytes stay in browser view grants |
| `execution recover` | L05 | Explicit local recovery, unchanged by X02 |
| `version`, `completion bash`, `completion zsh`, `completion fish` | X02 | Assembly-owned diagnostics and generated scripts |

No hidden aliases exist. Provider credential management, automatic
merge/deploy, and remote shell are out of scope.

## Server CLI routes

All under `/api/v1/cli`, all JSON, workspace taken from the binding:

| Route | Authority |
| --- | --- |
| `GET /api/v1/cli/version` | Public; frozen `{api_version, wire_protocol, cli_min_version, now}` |
| `GET /api/v1/cli/session` (C05) | Human credential; safe principal projection |
| `POST /api/v1/cli/session/revoke` | Human credential; revokes only its own binding |
| `GET /api/v1/cli/projects`, `GET /api/v1/cli/projects/:id` | Human credential; binding-narrowed project scope |
| `GET /api/v1/cli/tasks`, `POST /api/v1/cli/tasks`, `GET /api/v1/cli/tasks/:id` | Human credential; create needs explicit project and title |
| `GET /api/v1/cli/runs?task_id=`, `GET /api/v1/cli/runs/:id` | Human credential; run columns mirror the browser read |
| `POST /api/v1/cli/runs/:id/cancellation` | Human credential plus explicit `confirm` and fresh step-up proof |
| `GET /api/v1/cli/attention*`, `POST .../answer`, `POST .../resolve` | Human credential; explicit answer text and versions |
| `GET /api/v1/cli/artifacts?run_id=`, `GET /api/v1/cli/artifacts/:id` | Human credential; run-bound metadata only, no secrets |

Reads reuse the same domain reads as the browser handlers (`loadPrincipal`,
`getTask`, `listTasksPage`, `getAttention`, `listAttention`,
`listProjectsPage`, `getProject`). Writes dispatch the same hub commands
(`createTaskCommand`, `cancelRunCommand`, `answerAttentionCommand`,
`resolveAttentionCommand`, `revokeBindingCommand`) with the CLI human as
actor. Hub commands re-resolve the member's full grant, so the binding
project subset is enforced in the CLI layer before dispatch; out-of-scope
reads and writes answer `not_found`, mirroring the browser boundary.

## JSON envelope and exit codes

JSON mode (`--json`) prints exactly one document on standard output:

```json
{
  "schema_version": 1,
  "command": "task get",
  "request_id": "01J...",
  "api_version": "1",
  "data": {},
  "error": { "code": "not_found", "message": "..." }
}
```

JSON mode emits no prose; warnings and diagnostics go to standard error so
machine output stays parseable. Human mode prints concise lines on standard
output and `code: message` failures on standard error with empty standard
output.

| Exit | Codes |
| --- | --- |
| 0 | success |
| 2 | `invalid_request`, `unknown_method`, `invalid_json`, `body_too_large`, `invalid_argument` |
| 3 | `unauthenticated`, `forbidden`, `credential_confusion`, `credential_missing`, `step_up_*` |
| 4 | `control_unreachable`, `version_mismatch`, `daemon_offline`, `offline` |
| 5 | `internal_error`, `request_failed`, and any unmapped server code |
| 6 | `stale_version`, `already_answered`, `already_exists`, `conflict`, `expired_intent` |

Server prose never reaches CLI output: the client renders fixed text per
code. Flags precede positional arguments, following the repository flag
convention (`bfb task get --control-url URL TASK_ID`).

## Credential separation

- The CLI presents the human device credential as an `Authorization` bearer
  on `/api/v1/cli/*` only. Cookies and browser origins are rejected there
  with `credential_confusion`.
- Browser routes reject bearer credentials, runner routes demand possession
  proofs, and MCP demands OAuth: a CLI credential substitutes for none of
  them, and no runner, provider, or browser credential authenticates a CLI
  route.
- Secrets never appear in argv (secret-bearing flags are refused), standard
  output, standard error, logs, or diagnostics. Credentials travel in one
  owner-only (`0600`) file per state directory, in a proof file, or in the
  test-only `BFB_CLI_CREDENTIAL` override. Labels carry at most the workspace
  ID and public key prefix.
- macOS production stores the same item in Keychain as service `bfb-cli`,
  account `<workspace-id>` per the C05 contract, separate from the runner
  Keychain service. The v0.1 CLI file store is the portable behavior; the
  Keychain move is a documented limitation below.
- Logout revokes the binding server-side before forgetting the local copy;
  when the control plane is unreachable the local copy is still forgotten and
  the report says revocation did not confirm.

## Destructive and privilege-expanding operations

`run cancel` is the v0.1 destructive operation. It fails without both:

1. an explicit `--confirm run:<id>` naming the exact run, and
2. a fresh step-up proof (`--step-up-proof` or `--step-up-proof-file`)
   bound to action `cli:run:cancel` and target
   `cli:run:cancel:<run-id>:<expected-run-version>`.

The CLI prints the action/target handoff for the browser passkey step-up
flow; proofs are single-use, 15-minute bound, human-bound, epoch-fenced, and
consumed server-side before dispatch. Attention answers and resolutions need
explicit `--answer`/`--expected-version` flags but no step-up: answering
grants no authority. Task creation needs explicit `--project`/`--title`.

## Help, completion, version, offline

- `bfb help` lists the registered tree; per-command `--help` is usage text.
  `bfb completion bash|zsh|fish` prints scripts generated from the live
  command table, tested to contain every path and nothing else.
- `GET /api/v1/cli/version` is unauthenticated. `bfb version` always reports
  the client version; mutations refuse with `version_mismatch` when the
  server API major moves past the client's supported major, while reads
  proceed with a standard-error warning.
- Per-command offline behavior is frozen in the matrix: local commands work
  from local state (`run submit` journals `pending_sync`; hook ingest falls
  back to the local inbox); every control-plane read or write fails with
  `control_unreachable` and exit 4. The human CLI never queues offline
  mutations: the daemon journal is runner-plane only.

## Authorization parity

The same human observes the same records and the same rejections on the web
API and the CLI: `tools/human-cli/run.ts` drives both surfaces against one
seeded workspace and records `docs/work-packages/evidence/WP-X02/parity-report.json`.
`docs/work-packages/evidence/WP-X02/secret-scan-report.json` records the
secret scan over persisted rows and transcripts.

## Limitations

- macOS Keychain storage for the human credential is contracted but not yet
  implemented; the file store is the v0.1 behavior on all platforms.
- CLI artifact reads are metadata only; artifact bytes and new publications
  stay in the browser view-grant and local publish flows.
- CLI project, task, and run writes are the bounded set above; membership,
  policy, launch, discussion, notification, and review-decision writes stay
  in the browser.
- The CLI has no offline mutation queue and no TUI.

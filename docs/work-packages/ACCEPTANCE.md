# BFB v0.1 acceptance matrix

This matrix assigns every architecture release claim to the package that creates the proof. Feature packages own their tests; G01 composes every pre-release gate and runs adversarial cross-package cases; G02 completes the clean-install and release gates.

## Evidence rules

- Acceptance must run from a clean checkout against committed fixtures.
- Local/staging evidence records commit, schema/protocol version, migration head, tool/provider versions, environment, command, and outcome.
- Retained output may include JUnit/JSON reports, bounded redacted logs, screenshots, screen recordings, response headers, database assertions, and process traces.
- Evidence contains no cookie, bearer/grant secret, prompt/task body, local absolute path, raw hook payload, provider credential, artifact secret, or terminal transcript unless a test fixture is synthetic and visibly marked.
- A flaky or manual-only check is not a release gate. macOS consent/notarization cases may include a documented manual observation only when automation cannot exercise the OS dialog; the surrounding state assertions remain automated.
- `passed` means the negative cases pass too. A happy-path demo is insufficient.

## Architecture gates

| Gate | Release claim | Primary owner | Contributing packages | Required proof |
| --- | --- | --- | --- | --- |
| AG-01 | Three humans have different workspace/project/runner access and cannot cross tenant boundaries | C04 | C02, C06, C07, C08, L08, W01, X03A | Exhaustive permission matrix at API/MCP/repository/UI layers; ungranted Mac wake rejected |
| AG-02 | Card Start opens the selected provider in the exact registered working directory and blocks unsafe cases | L05 | C09, L02, L04, L07, L08, W02 | Real macOS launch trace plus moved/mismatched/occupied/offline/locked/consent/containment tests |
| AG-03 | Daemon/network loss and concurrent runs lose or misattribute no accepted events | E01 | F02, L05, L06, L08, E02 | Fault injection at heartbeat/inbox/SQLite/upload/ack/replay boundaries; explicit dispositions and cursor-race suite |
| AG-04 | Claude, Codex, and Grok share lifecycle semantics without false completion | L07 | L03, P01, P02 | Common provider fixture suite plus provider capability/degradation reports |
| AG-05 | Agent requests human attention, waits/reads, receives an authorized answer, and continues | A02 | A01, E02, X01 | End-to-end attention trace including timeout, reconnect, permission mismatch, notification dedupe |
| AG-06 | Plan/HTML artifacts publish, render safely, review immutably, and lose approval on new version | V03 | V01, V02 | R2/D1 failure matrix, hostile-browser corpus, version/review binding tests |
| AG-07 | Human, process, activity, wait, and token measurements remain separate and provenance-labelled | A04 | E01, A02, A03 | Interval/property tests, duplicate replay, unavailable/estimated/provider usage fixtures, UI traceability |
| AG-08 | Revocation disables runner/CLI/OAuth/membership/project authority before cleanup and closes live channels | C04 | C05, C06, C07, C09, L08, A01, E02, X03A, X03 | Race tests at command claim, final auth, API/MCP call, token renewal, pending replay, and socket close |
| AG-09 | Malicious task/link/event/artifact data cannot alter local commands or access trusted APIs; view secrets never leak | G01 | F02, L03, L05, V02, W02 | Injection corpus, command capture, CSP/sandbox browser report, URL/log/history scan |
| AG-10 | Clean Cloudflare and Mac installs reproduce the vertical flow | G02 | F03, F04, L04, L08, X02, X05 | Recorded blank-account and blank-Mac install, first-owner bootstrap, provider flow, artifact review, upgrade/recovery smoke |

## Additional security and operations gates

| Gate | Release claim | Primary owner | Contributing packages | Required proof |
| --- | --- | --- | --- | --- |
| SG-01 | Browser identity, passkey step-up, CLI credentials, runner credentials, and remote MCP credentials cannot substitute for one another | G01 | C02, C03, C05, C06, X03A, X03 | Credential-type confusion matrix and route-level rejection tests |
| SG-02 | Every workspace mutation commits through the hub FIFO with D1 constraints/idempotency as backstop | C01 | F04, C04, C07, C08, C09, E01, V01 | Delayed-D1 concurrency test, stored-idempotent-result test, repository mutation audit |
| SG-03 | D1/R2 partial failure never exposes an incomplete artifact and same-hash publication cannot race deletion | V01 | F04, C01, X05 | State-boundary fault injection, conditional write tests, proof of no v0.1 artifact delete path |
| SG-04 | Auth/passkey/OAuth plugin defaults cannot expose bypass routes or flows | G01 | C02, C03, X03A, X03 | Route inventory snapshot and negative tests for Organization, passkey mutation, CIMD/DCR/client CRUD/client credentials/JWT |
| SG-05 | Logs, diagnostics, notifications, webhooks, and audit contain no prohibited secret/private payload | G01 | L01, X01, X04, X05 | Seeded canary secret/content scan across all output channels |
| OG-01 | Queue/DLQ/outbox retry and GitHub redelivery cause one effect and remain recoverable | X04 | C01, X01, X05 | Crash-gap, duplicate/out-of-order, poison-message, DLQ, Cron recovery tests |
| OG-02 | Empty/previous migrations, key rotation, deployment, rollback limits, and forward repair are reproducible | G02 | F03, F04, C01, C02, X05 | Migration matrix, Time Travel/export evidence, key-overlap drill, Worker/data rollback decision trace |

## Checkpoint ownership

| Checkpoint | Owner | Must remain green afterward |
| --- | --- | --- |
| IC-0 Platform | C01 | Repository verification, generated-contract drift, local Cloudflare smoke, empty/previous D1 migration, hub serialization |
| IC-1 Team workspace + remote MCP | X03A | IC-0 plus human auth, step-up, tenant/project permission, work-record, board, OAuth delegation, protocol-routing, revocation, real browser-cookie separation, and synthetic reserved-format negatives for credentials owned by later packages; SG-01/G01 owns the real cross-credential matrix |
| IC-2 Trusted Mac | L08 | IC-1 plus daemon, checkout, provider fake, app pairing, signed-component key access, multi-workspace runner isolation |
| IC-3 Provider-neutral tracked launch | W02 | IC-2 plus fake-provider launch contention/final auth, PTY/lock/containment, run-control, and recovery traces |
| IC-4 Truthful live run | E02 | IC-3 plus offline journal, ingest dispositions, event replay race, presence semantics |
| IC-5 Claude human loop | A04 | IC-4 plus real Claude launch/session binding, local MCP boundaries, attention, result transitions, and measurement provenance |
| IC-6 Visual review | V03 | IC-5 plus upload fault matrix, viewer hostile corpus, immutable review binding |
| IC-7 Provider/external parity | G01 | IC-6 plus Codex/Grok, notification, CLI, remote MCP, GitHub, operations suites |
| IC-8 Release | G02 | Every preceding checkpoint from tagged release artifacts in clean environments |

## Completion report

G01 maintains the release-gate report with one row per gate. It must complete every gate except G02-owned AG-10 and OG-02, which remain `not_run` until G02 runs them and publishes the final report:

| Field | Meaning |
| --- | --- |
| Gate | Stable gate ID above |
| Status | `not_run`, `failed`, `passed`, or `waived` |
| Commit | Exact tested commit/tag |
| Schema | Protocol version and D1/local migration heads |
| Environment | Local/staging/clean-account/macOS and provider versions |
| Command | Reproducible test command or bounded OS-manual procedure |
| Evidence | Repository path to redacted report/capture |
| Waiver | ADR and Timo’s explicit decision; absent for normal passes |

A waiver is not silently equivalent to passing and cannot override a core architecture trust boundary without revising the v0.1 architecture.

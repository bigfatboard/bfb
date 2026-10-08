# A03 result transition matrix

Proven by `pnpm test:a03` on the tested commit. Every row is an automated
assertion; no transition exists outside this table.

## Run transitions (`run.result_state`)

| From | To | Command | Proved by |
| --- | --- | --- | --- |
| `open` | `submitted` | `result.submit` | domain submit test, worker v1 check, route submit test |
| `changes_requested` | `submitted` | `result.submit` | domain cycle test (v2), worker v2 check |
| `submitted` | `changes_requested` | `result.request_changes` | domain cycle/matrix tests, worker race, route test |
| `submitted` | `accepted` | `result.accept` | domain cycle test, worker accept, route accept test |
| `open` | `failed` | `result.fail` | domain close test, worker fail check, route fail test |
| `changes_requested` | `failed` | `result.fail` | domain close test |
| `open` | `cancelled` | `result.cancel` | domain close test |
| `changes_requested` | `cancelled` | `result.cancel` | domain close test, route terminal test |

Illegal transitions fail closed with `invalid_transition`: submit on
`submitted`/`accepted`, review on non-`submitted`, review of a superseded
submission, fail/cancel on `submitted`/`accepted`/`failed`/`cancelled`,
activity or execution changes on terminal runs, agent submission after
execution end.

## Task coupling (atomic inside the same hub command)

| Run transition | Task transition |
| --- | --- |
| `open` → `submitted` | `active` → `review` |
| `submitted` → `changes_requested` | `review` → `active` |
| `submitted` → `accepted` | `review` → `done` |
| fail / cancel | none (task is already `active`; submission requires `active`) |

## Outdated computation (read-time, never stored)

| Reason | Trigger | Proved by |
| --- | --- | --- |
| `superseded` | a newer version exists for the run | domain cycle test, worker history check, browser superseded screenshot |
| `config_changed` | bound `config_hash` differs from the run's latest snapshot | domain config-change test |
| `evidence_changed` | bound ref `version` differs from the current version map | domain evidence-map test (V01 supplies artifact versions) |

## Terminal invariants

- `accepted`, `failed`, `cancelled` close every run-scoped agent capability
  (Go terminal-close tests, worker race, domain lease test).
- Review and result commands never read or write `checkout_leases`
  (byte-identical lease assertion in domain and worker tests).
- Runner event ingest of any kind never mutates `run.result_state`
  (domain no-inference test over turn/tool/session/execution endings plus
  `result_submitted`, `run_failed`, `run_cancelled`, heartbeat rows).

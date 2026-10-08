# A03 acceptance matrix (role and negative behavior)

Proven by `pnpm test:a03` on the tested commit. Roles are workspace roles
with project access; the agent acts only through its run-bound runner
authority.

## Authority matrix

| Action | agent_run (own run) | reviewer | member | owner |
| --- | --- | --- | --- | --- |
| `result.submit` | allowed | forbidden | allowed | allowed |
| `result.request_changes` | forbidden | allowed | allowed | allowed |
| `result.accept` | forbidden | forbidden | allowed | allowed |
| `result.fail`, `result.cancel` | forbidden | forbidden | allowed | allowed |

Proved by: domain matrix and self-acceptance tests, worker reviewer-submit
and agent-accept checks, route reviewer-submit (403) and reviewer-accept
(403) tests, browser reviewer-accept (403) check, Go provisional/terminal
capability tests.

## Negative cases (all fail closed, none mutates state)

| Case | Code | Proved by |
| --- | --- | --- |
| Stop, tool failure, terminal close, session end, process exit as results | never submitted (explicit submit only) | domain no-inference test, headless predicate matrix |
| Interactive mode, non-zero exit, missing attestation as auto-submit | `false` from `isUnambiguousHeadlessSuccess` | domain predicate matrix (7 negatives) |
| Delegated remote client submits | `forbidden` | domain delegation test |
| Reviewer submits or accepts | `forbidden` | domain, worker, route, browser tests |
| Agent accepts, requests changes, fails, or cancels | `forbidden` | domain self-acceptance test, worker agent-accept check |
| Duplicate evidence refs in one submission | `invalid_argument` | domain evidence test, worker duplicate check |
| Smuggled evidence field / bad git commit / oversize summary | `invalid_argument` | domain evidence test, Go validation matrix, CLI tests |
| Stale expected run/task version on review | `stale_version` | domain stale test, worker stale-accept check, route 409 test |
| Review of a superseded submission | `invalid_argument` | domain cycle test |
| Submission against a non-active task | `invalid_transition` | domain blocked-task test |
| Agent submit without assignment, grant, or live execution | `forbidden` / `invalid_transition` | domain agent-negative test, Go assignment checks |
| Offline submit where policy prohibits pending sync | `offline_rejected` | Go policy-refusal test |
| Journal replay after revocation, execution end, terminal result, expiry, or policy change | terminal rejection, no re-execution | Go replay matrix, worker race |
| Unknown CLI assignment, wrong correlation, bearer-polluted env | visible rejection, no journaled effect | Go CLI tests, real-binary CLI harness |

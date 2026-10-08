# WP-V03 permission matrix

Proven by `packages/domain/test/artifact-reviews.test.ts` (matrix test),
`apps/control-worker/test/artifact-review-routes.test.ts` (403 case), and the
cross-isolate runner case in `tools/artifact-review/run.ts`.

Artifact binding: when the artifact names a run, the reviewer needs project
access to that run's project. Run-free artifacts need workspace membership only.
Step-up is never required to record a review, and a recorded review is never
usable as step-up or authority elsewhere.

| Actor | Ordinary review (`approve` / `request_changes` / `comment`) | Result accept | Launch / policy / credential |
| --- | --- | --- | --- |
| owner, project access | allowed | allowed (A03 rules) | only through their own commands |
| member, project access | allowed | allowed (A03 rules) | only through their own commands |
| reviewer, project access | allowed | forbidden (unchanged by approval) | forbidden |
| reviewer, no project access | `forbidden` | forbidden | forbidden |
| runner actor | `forbidden` | forbidden | forbidden |
| delegated (remote OAuth) actor | `forbidden` | forbidden | forbidden |
| system actor | `forbidden` | forbidden | forbidden |
| stale authorization epoch | `stale_authorization` | rejected | rejected |

A review records no authority: after an approval, run `result_state`, task
state, submission history, launch commands, policies, and credentials read
back identical, and the approving reviewer still cannot accept the result.

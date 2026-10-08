# C11 task-detail panel selection

Existing result, measurement and artifact-review panels now bind asynchronous
delivery to the current task/API/artifact selection and newest operation.
Snapshots install coherently; current denial clears delivered records/actions
and retains an explicit retry. This is presentation hardening, not a replacement
for server authorization or new private controls.

Tested and production source: `96874359dcd335021028d07eacb27fe300e1da93`.
Protocol: unchanged `bfb-wire/1`.
D1 head: `0047_security_audit_positions`; no migration added.

C11 remains `in_progress`. Private creation, creator sharing, inherited private
children and author-private checkpoints stay disabled; C12 is planned.

## Current selection and completion

The focused target passes seventy cases in six files, including thirty-four new
mounted cases and existing panel/disclosure controls. A task or artifact
A-to-B-to-A return cannot revive the first A response. Stale bodies, errors,
pending finalizers and unmounted mutation completions cannot affect current
panels or trigger old-scope follow-up reads/callbacks.

Runs/submissions, measurements/timers and artifact lists/origin/selection install
as coherent snapshots. Current authority-denial presentation removes records,
viewer and actions rather than showing an authorized empty state. Original
mutation targets and local draft revisions are retained through body parsing
and follow-up reads. Notes edited during POST survive, even when their value
returns to its submitted value; artifact notes stay bound to their artifact.
Synchronous single-flight prevents rapid duplicate mutation POSTs.

Hidden visited sections stay hidden. The existing label-only notice remains
the opt-in route to a section error without copying record/error text or
automatically expanding Details. Existing W03 disclosures, two default task
actions, light/dark themes, inert notes, explicit viewer activation, measurement
provenance and separate result/artifact decisions remain in the regression gate.

## Old source and later regression probes

The original twenty-five frozen cases were independently replayed against
committed unfixed source `6fb6623991c5540c27e6f2a5f71488cd844cca5f`:
twenty meaningful failures and five controls, with nine expanded cases skipped.
The three panel sources are git-identical through `4a7b399`. Only the test file
was copied; no fixed panel/helper was copied and older untracked probes were not
run. This confirms the initial local OLD record, not old-source package
acceptance or replay of all thirty-four cases.

Failures distinguish selection re-entry, newest API incarnation, partial
snapshots, artifact status, current-denial clearing, stale/unmounted mutation
completion and hidden-panel content. Five controls retain healthy panels,
ordinary validation/transient failures and artifact version conflicts.
The later nine-case probe on partially hardened source recorded two failures
and seven passes before the single-flight repair. It is separate from committed
OLD evidence. All thirty-four mounted cases pass on tested source.

## Browser and clean verification

Six Chromium scenarios pass in light and dark themes. Every workspace POST in
these scenarios, including incidental viewer grants, is intercepted synthetic
presentation; no business mutation is admitted. Healthy artifact/measurement
GETs use disposable V03 server fixtures. Result task state, runs and submissions
are synthetic presentation responses. These checks do not prove server ACLs or
artifact-byte delivery.

Retry and section-reveal controls are explicitly focused before Enter. Natural
Tab traversal and native popup-key navigation are not proved. Result and
Measurements expose Loading text and disabled actions; only ArtifactReview has
`aria-busy`. Root inspected two ephemeral output captures, not every capture or
a broad visual audit.

The completed unchanged clean pipeline records
`C11_DETAIL_PANELS_CLEAN_CERTIFICATE_OK`. Exact C11 passes 2,684 stage-case
invocations in 107 file invocations, plus six detail-panel browser cases and
C10/C08 dependencies. The retained sixteen D1 harnesses pass 206 checks; this
UI slice adds no native-D1 proof. The separate notification drill passes with
41 record labels, which include setup and repeated dispatch/redaction rather
than forty-one independent cases.

Exact W03 passes 239 unit cases in thirty files and 91 shared browser cases,
including the same six detail-panel scenarios. Full verification passes 4,772
TypeScript cases in 218 files, Go and all sixteen Swift cases without skipping
selected platform checks. Frozen installation, before/after worktree checks,
unchanged source and empty final status pass. The additive detail-panel target
is composed once by C11. No fresh standalone X03 certificate is claimed.

See the [manifest](detail-panels-manifest.json) and
[command result](detail-panels-command-result.json).

## Remaining boundaries

Backend authority certificates remain separate and historical evidence is
unchanged. Malformed measurement-source lineage, GitHub key policy,
execution-owned private delivery, destructive retention, artifact-byte consumers
and broader temporal/lease boundaries are outside this corrective UI proof.
No installed-app, persistent-pilot, live-provider, rollout or complete C11
certificate is included. Other mandatory product features remain separate work.

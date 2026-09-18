# L05 native Terminal supervision matrix

Certified revision: `d0b286d4f65f8f38ee55ab52098c6d7b797713b0`. Exact command:
`pnpm test:l05` (supervisor fixtures, protocol parity, Go race suites,
Swift checks, signed Terminal integration, managed macOS acceptance).
Three consecutive implementation-checkout passes plus a clean-checkout
pass after one fail-closed clean-checkout failure (one failure in five
full gates); all references below are synthetic fixtures, not user work.

| Boundary | Executable evidence | Observed outcome |
| --- | --- | --- |
| Fixture drift | `node tools/supervisor/fixtures.mjs --check` | 101 owned fixtures agree in every run |
| Wire parity | TypeScript suite plus Go differential fixtures | 438 protocol tests pass; Go fixtures agree |
| Native races | `go test -race` over supervisor, appbridge, daemon, CLI and command packages | All five packages pass, including PTY/process-group, lock, inspection and control suites |
| Swift checks | Format lint plus Xcode build and test | 16 native tests pass with no failures |
| Exact start | Signed integration with the synthetic provider | Provider starts in the exact registered root and records actual kernel, cwd, Git, argv and scoped-environment facts |
| Unsafe starts | Moved/replaced/occupied checkout, expired/cancelled command, revoked grant, stale snapshot, locked session, consent denial | Every case blocks safely without a provider child |
| Concurrent claim | Two aliased starts race one intent | Exactly one execution registers |
| Pre-exec swap | Replaced binary/symlink, version, integration hash, repository config, capability manifest after claim | Every swap blocks before `exec`; no prior probe grandfathers it |
| Scoped environment | Captured provider environment | Only the documented scoped `BFB_*` values plus the normal local environment; no task text, no MCP mutation authority; artifacts resolve outside the checkout |
| Parent exit | Provider parent killed while a same-group child lives | Lock stays held, heartbeat continues, zombie leader reserves the group identity |
| PID reuse | Internally consistent stale PID/start record | Fresh kernel inspection refuses the signal; no other process is touched |
| Escape | Descendant leaves the owned group | Sticky `containment_unknown`; remote recovery cannot clear it; local recovery fails until process and lock absence are proved |
| Heartbeat | 15-second verified group-presence observations | Heartbeats continue only while the owned group is alive; an idle prompt is never labelled working |
| Run controls | Duplicate, stale, expired and foreign-assignment controls | One effective local action; only bound fresh controls focus, signal, resume or terminate |
| Captured command | Fixed helper path plus `__launch` and the local intent UUID | No cloud, task, profile or checkout data; never a wake-intent value |
| Real focus | `focus_existing` against the owned tab before signalling | Terminal frontmost with the owned tab selected in the Ctrl-C and close scenarios |
| Real Ctrl-C | System Events keystroke under frontmost and owned-tab checks | Exactly one SIGINT through the TTY foreground group; duplicates produce no second signal |
| Real close | Provider-only window close with one confirmation answer | Exactly one close signal and a verified whole-group release |
| Cleanup | Harness finally blocks | Test app quits, Terminal windows under test close, no provider or helper process remains |

## Bounded synthetic trace

Each run mints a fresh daemon-local intent UUID, a random run-scoped
correlation value and a private artifact directory outside the checkout;
their values are never retained. The managed acceptance fixture reuses its
fixed synthetic UUID and wake ULID, which cannot substitute for one another.
The signed scenarios assert exact checkout identity, observed provider
image, fixed helpers, bound duplicate controls, surviving-child heartbeat,
sticky escape, signed local recovery, whole-group release, human-like
Ctrl-C and real window close. No raw Terminal transcript, correlation
capability or local path is kept.

## Observed limits

A close confirmation sheet can hold the provider-only close until it is
answered once; once the close signal lands the window is gone and no
further key is sent. One earlier Ctrl-C run stalled safely on an extra
group member with an unrooted identity; the supervisor refused uncertain
ownership rather than signalling. The first clean-checkout run of this
certification failed its interactive scenario the same safe way: one
SIGINT, a provably ended group, but a same-instant uncertainty capture
from the owner/record check (the extra same-group child was fully rooted
and is not the source) that wedged the cloud release leg past the release
wait. One such failure occurred in five full gates; every instance failed
closed with the lock retained and no ambiguous signal sent. Terminal open
waits briefly for the scripting interface; a cold start beyond that poll
fails safe. The synthetic `--require-focus` routing section of the macOS
acceptance harness is not invoked by any gate; exact-tab focus is covered
by the signed scenarios instead. A same-group survivor cannot outlive a
real close, so survivor retention after close stays covered by the child
and escape scenarios.

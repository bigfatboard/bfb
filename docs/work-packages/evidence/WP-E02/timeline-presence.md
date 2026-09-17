# Timeline and presence report (E02)

Projections: `apps/web/src/realtime/timeline.ts` and `presence.ts`, covered by
`apps/web/test/realtime-timeline.test.ts` and `realtime-presence.test.ts`,
plus the `e02-realtime` Playwright suite and `browser/` screenshots.

- Timeline entries are fixed per-kind summaries (for example `turn_started`
  becomes "Agent turn started"); unknown kinds stay "Recorded run event".
  No summary claims a result, acceptance, or completion.
- Actor renders as Runner or Agent run; provenance derives from the actor
  type (`daemon-observed` for runner actors, `agent-reported` otherwise)
  because the replay envelope carries no capture-origin field. Each entry
  shows the bound execution id, assignment generation, provider session id
  when present, and its committed cursor.
- Connectivity, process presence, and activity are separate: `live` needs an
  open socket with a signal inside 45 seconds; `stale` never mutates run
  state. Heartbeats prove liveness only: heartbeat-only runs are `idle`,
  never `working`; `working` requires an open normalized turn interval and a
  terminal execution row closes it. Empty runs are `unknown`.
- Human presence uses committed task comments only ("Last human note …");
  with no committed human activity the UI says so. v0.1 has no committed
  review records, so the UI never renders a "Reviewed …" claim and browser
  presence is never presented as attention or work time.
- Hostile event strings (for example `<img src=x
  onerror=alert(document.domain)>`) render as escaped text: the committed
  bytes stay intact as data while the DOM contains zero injected elements
  (`browser/hostile-timeline.png`, `browser/hostile-timeline.md`).

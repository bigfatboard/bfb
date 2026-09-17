# Replay-race matrix (E02)

Deterministic suite: `apps/web/test/realtime-resync.test.ts` (10 cases, vitest).
The machine starts buffering at socket open; invalidations are hints and only
replay pages apply envelopes, deduped by event id and ordered by workspace cursor.

| Race point | Injection | Expected | Result |
|---|---|---|---|
| Before subscription | Cursors 1-3 committed, then socket opens | `fetch(0,3]`, applied `[1,2,3]`, live | passed |
| Before high-water capture | 1-2 committed, socket opens, 3-4 committed pre-ready | Buffered `[3,4]`, replay covers all once | passed |
| At high-water capture | Cursor 1 committed as the ready mark is taken | Inclusive `through` replays it; buffer empty | passed |
| After capture, during replay | Ready H=3, fetch in flight, cursor 4 committed | Buffered, drain `fetch(3,4]`, applied `[1-4]` | passed |
| During drain | Drain `(3,5]` in flight, cursor 6 committed | Second drain `(5,6]`, applied `[1-6]` once | passed |
| No replay yet | Invalidations 7-8 with no ready/fetch | Applied stays empty until authoritative replay | passed |
| Overlapping pages | Duplicate envelope across pages | Applied once per event id | passed |
| Out-of-order page | Page `[3,1,2]` | Applied `[1,2,3]` | passed |
| Failed replay | `replay-failed`, then `retry` | Resume fetch, converge to live | passed |
| Long backlog | 4 cursors paged 2-by-2 via `has_more` | Follow-up `fetch(2,4]`, no skip | passed |

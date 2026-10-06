# W03 UI verification

The declared gate passed from the committed source identified in the manifest.
This certifies the local UI package, not a production deployment or the whole
MVP. CI was not run; the committed evidence is from local clean-checkout gates.
No live pilot, provider session, Terminal consent or execution behavior was
changed or used.

## Interaction proof

- Owner, member and restricted/reviewer cards each expose Open and Details.
  The task overview exposes a contextual command and Task section. Comment
  composition is absent until requested; its explicit form uses Add/Cancel.
- Attention rows expose at most Answer/Resolve and Details. Answers retain
  drafts through cancel, section disclosure, failed polling and rejected
  commands. Native provider permissions remain visibly distinct from answers.
- Existing workflows remain reachable: create/promote/edit/handoff, context
  audiences, comments, result and exact artifact review, timers, history,
  account security and role-aware secondary routes. The full shared suite
  exercises existing launch/discussion controls only against synthetic fixtures.
- Closing restores card focus and board position. Narrow dialogs bound Tab
  focus and make background controls inert; close restores those controls.
- Task/workspace reads and late review callbacks are fenced, including
  A-to-B-to-A selection. Old commits cannot clear a new draft. Context body and
  audience are retained together. Unrelated saves retain edit/handoff drafts
  and their original version; explicit conflict reload restores canonical state.
- A late failure in a hidden mounted section raises a label-only notice and
  an explicit reveal action. Failure bodies stay in that section; new activity
  never expands it automatically.
- Escaped hostile titles/comments, denied reads, recovery, empty projections,
  feature-disabled/pending/malformed/unavailable states and role restrictions
  remain covered. Artifact bytes still require an explicit isolated preview.

## Visual and accessibility proof

The retained report records 320, 390, 768 and 1440px layouts without document
overflow, accessible account controls, reduced motion and 200% zoom. System
appearance follows media changes; explicit Light/Dark persists across reload.
Browser samples cover 90 visible product text nodes per theme: the minimum
measured ratio is 6.21:1 in light and 7.09:1 in dark. Unit checks additionally
cover 62 token pairs, including actions, priorities, errors and focus.

The light/dark boards, project lanes, task overview, attention composer and
narrow comment flow were inspected after rendering. Default controls remain
named and visible, not hover-only; form text uses normal weight and focus is
visible. Captures use synthetic data, are viewport-bounded and total under
1 MiB. They are supplemental evidence, not pixel-golden comparisons; titles
created by the shared regression suite may contain synthetic timestamps.

## Reproduction and redaction

`pnpm test:w03` owns the exact acceptance gate. To retain new synthetic
captures, set `BFB_CAPTURE_W03_EVIDENCE=1` with that target or with
`pnpm test:w03:browser`. Never point the harness at a live workspace.

Only bounded counts, outcomes and synthetic viewport images are retained.
No cookie, credential, real task body, local absolute path, raw terminal log
or hook payload is committed. Prior package evidence remains historical and
unchanged; fixture replay and passkey-flow corrections are regression-covered.

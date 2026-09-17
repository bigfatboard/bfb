# WP-D02 exact-version fixture summary

| Provider | Installed version | Adapter tested version | Evidence |
| --- | --- | --- | --- |
| fake | 1.0.0 (`cmd/bfb-fake-provider`, built from this checkout in `TestMain`) | 1.0.0 | Full fault matrix, scheduler, output, and recovery suites |
| codex | 0.153.4 (`codex-cli 0.153.4`) | 0.153.4 | Real-binary probe, health, read-only fresh and exact-session continuation planning in a temporary home; no model call, no credential use |
| claude | 2.1.275 (`2.1.275 (Claude Code)`) | 2.1.274 | Headless turn fails closed through the real adapter; version differs from the tested one, so no capability evidence transfers |

D01 synthetic fixtures (62) pass unchanged through
`node tools/discussions/fixtures.mjs --check`. D1 migration
`0025_discussion_delivery` adds covering indexes only; the D01 delivery state
machine is untouched. Capability evidence never transfers between versions:
the Claude observation above is a fail-closed proof, not a certification.

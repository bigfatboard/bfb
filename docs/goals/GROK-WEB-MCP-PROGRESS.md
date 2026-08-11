# Grok web + remote MCP execution journal

This file is the resumable execution journal for [the Grok web/MCP goal](GROK-WEB-MCP.md). It is operational state, not acceptance proof.

## Resume checkpoint

- Goal state: `active — correction and re-certification`
- Branch: `goal/grok-web-mcp`
- Last observed HEAD: 696e3ccf33ba590a4a50a3f53dc448ca9cd4f639
- Last verified commit: 696e3ccf33ba590a4a50a3f53dc448ca9cd4f639
- Last verification command/result: `pnpm verify` and `pnpm test:ic1` passed at the pushed tip, but the independent final review reproduced a real `workerd` startup failure and acceptance gaps those commands did not exercise
- Active package: F01 — repository foundation
- Active gate: correct the evidence/status gate, then re-run F01 from a clean checkout
- Active task: require clean-checkout evidence for `done` packages and make package state truthful
- Resume here: finish F01 correction, commit its clean-checkout proof, then advance sequentially through F02 → F03 → F04 → C01 → C02 → C03 → C04 → C07 → C08 → W01 → X03A
- Blocking condition: `none`
- Updated UTC: `2026-08-11T14:53:06Z`

## Final review findings

- P0: the control Worker does not start in real `workerd`; a named constant export is interpreted as an invalid Worker export.
- P1: package evidence/status validation accepted local evidence as clean-checkout completion.
- P1: identity, passkey step-up, workspace authorization, work records, W01, and OAuth/MCP omit required acceptance paths.
- P1: OAuth/MCP has protocol, boundary, idempotency, and token-lifecycle failures reproduced by live probes.

## Package status

F01 is reopened for correction. F02–X03A are planned again and must be re-certified in dependency order. PR #3 remains open and must not merge until this journal returns to `complete` with clean-checkout proof.

Mark a journal handoff complete only after the canonical package is `done`, its declared test passes from a clean checkout, its evidence manifest exists, and that manifest's tested implementation commit is recorded.

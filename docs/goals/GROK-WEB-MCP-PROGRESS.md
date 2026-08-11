# Grok web + remote MCP execution journal

This file is the resumable execution journal for [the Grok web/MCP goal](GROK-WEB-MCP.md). It is operational state, not acceptance proof.

## Resume checkpoint

- Goal state: `active — correction and re-certification`
- Branch: `goal/grok-web-mcp`
- Last observed HEAD: 71f9f588dd94f6191ef963a22bcfd715c54447a1
- Last verified commit: 71f9f588dd94f6191ef963a22bcfd715c54447a1
- Last verification command/result: clean clone `pnpm packages:verify`, `pnpm test:ic1`, and `pnpm worktree:check` passed; 34 test files / 178 tests in the repository gate, IC-1 unit/browser/MCP regressions, Go checks, unsigned Xcode build/test, roadmap validation, and clean-worktree assertions passed
- Active package: F02 — wire contracts and test doubles
- Active gate: audit generated TypeScript and Go validators against the canonical schema, then run `pnpm test:protocol` from a clean checkout
- Active task: add missing cross-language constraint and numeric-boundary cases before re-certification
- Resume here: finish F02 correction and evidence, then advance sequentially through F03 → F04 → C01 → C02 → C03 → C04 → C07 → C08 → W01 → X03A
- Blocking condition: `none`
- Updated UTC: `2026-08-11T15:05:00Z`

## Final review findings

- P0: the control Worker does not start in real `workerd`; a named constant export is interpreted as an invalid Worker export.
- P1: package evidence/status validation accepted local evidence as clean-checkout completion.
- P1: identity, passkey step-up, workspace authorization, work records, W01, and OAuth/MCP omit required acceptance paths.
- P1: OAuth/MCP has protocol, boundary, idempotency, and token-lifecycle failures reproduced by live probes.

## Package status

F01 is re-certified at tested commit `71f9f588dd94f6191ef963a22bcfd715c54447a1`. F02 is active; F03–X03A remain planned and must be re-certified in dependency order. PR #3 remains open and must not merge until this journal returns to `complete` with clean-checkout proof.

Mark a journal handoff complete only after the canonical package is `done`, its declared test passes from a clean checkout, its evidence manifest exists, and that manifest's tested implementation commit is recorded.

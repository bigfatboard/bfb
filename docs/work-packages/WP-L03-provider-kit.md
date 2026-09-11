# WP-L03 — Provider adapter kit

Status: `planned`

Risk: High

## Outcome

Claude, Codex, Grok, and a fake provider implement one narrow tested lifecycle without forcing unsupported capabilities into false parity.

## Dependencies

- **Requires:** F02, L01.
- **Unlocks:** A01, D02, L05, L06, L07, L08, P01, P02, W02, X02, X05.
- **Can run with:** L02 and control-plane work after F02.

## Scope

- Define `probe`, capabilities, interactive/headless launch plan, resume, interrupt, terminate, and hook normalization interfaces.
- Define reviewed capability manifests keyed by provider and tested version range.
- Intersect workspace/profile requirements, packaged manifest, and runtime probe.
- Map typed execution configuration to local executable and explicit argv; never accept cloud argv.
- Implement fake provider/adapter for hooks, controlled exits, hanging, children, unsupported capabilities, and process-group escape.
- Make each provider register through its own provider-local descriptor and aggregate registrations deterministically, so parallel provider packages never edit a shared registry or root command.
- Define provider-owned raw-hook parsing into a bounded semantic candidate. L06 owns correlation validation, the BFB event envelope, persistence, sequencing, and upload.
- Define setup/doctor transactions with an explicit BFB-owned diff, human approval, expected configuration hash, lock/CAS, atomic replacement, recovery copy, post-write doctor check, and rollback on failure.
- Record the probed executable's canonical identity, version, integration hash, and capability-manifest identity for L05's immediate pre-exec revalidation.
- Block unknown versions for required tracked behavior or expose explicit policy-controlled degradation.
- Preserve provenance and separate context injection from initial-turn transport.
- Define discussion turn planning, exact-session continuation, observed turn/session identity, bounded structured output, and optional fork/native external-message capabilities under ADR 0002. Peer content is external data, not human authority.
- Run an early bounded Claude/Codex experiment for fresh/resumed/forked sessions, read-only tool boundaries, cancellation, wrong/busy-session rejection, and native delivery before freezing these contracts. Record exact versions; help output is discovery only. Do not adopt an additional SDK runtime or unsupported production transport implicitly.

## Non-goals

- Dynamic third-party plugins, parsing `--help` as capability truth, shell commands, keystroke simulation, provider-config rewrites without an approved diff, or pretending every provider supports identical hooks/usage/resume.

## Work plan

1. Implement interfaces/manifests, provider-local registration, and the fake provider/adapter.
2. Add launch-plan injection tests and capability intersection.
3. Add transactional setup/doctor contracts, semantic-preservation fixtures, and unknown-version behavior.
4. Capture a bounded capability probe against the selected Claude/Codex/Grok versions before provider packages start.

## Acceptance

- Malicious task/profile/checkout strings cannot alter executable or argv; only the fixed manifest-approved initial instruction may enter its documented transport.
- Unknown versions fail closed for required tracked capabilities.
- Fake provider covers interactive, headless, resume, interrupt, termination, child, and escape cases.
- Replacing the probed binary, symlink target, version, provider configuration, or integration hash before execution invalidates the launch plan.
- Setup changes only approved BFB-owned entries, detects a concurrent edit, writes atomically, and restores the prior valid configuration if doctor fails.
- Stop, terminal close, tool failure, or process exit never becomes result submission.
- Context injection alone never marks a first turn as started.
- Discussion permissions do not widen through inherited hooks, MCP servers, tools, resume/fork defaults, or peer text. An unsupported read-only boundary fails closed.
- Capability evidence distinguishes supported, unsupported, and unverified fresh/resume/fork/idle-delivery/active-delivery/interrupt behavior; unknown versions never inherit certification.

## Evidence and handoff

- Commit adapter contract, fake provider, provider-local registration contract, configuration-transaction fixtures, capability matrix, injection corpus, and version-policy fixtures.
- Provider packages own only their provider-local adapter, descriptor, manifest, setup logic, raw-hook parser, and fixtures after this freezes.

## Risks and decisions

- Provider auto-updates require a short-lived probe and immediate pre-exec version check.

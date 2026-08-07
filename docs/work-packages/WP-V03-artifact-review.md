# WP-V03 — Immutable artifact review

Status: `planned`

Risk: High

## Outcome

A human reviews an exact artifact version and records approval, changes requested, or comment without that decision leaking to later bytes or elevating unrelated permissions.

## Dependencies

- **Requires:** A03, A04, V02, W01.
- **Unlocks:** G01.
- **Can run with:** P01/P02 after feature contracts freeze.

## Scope

- Add artifact/code review records bound to immutable `artifact_version_id`, hash, reviewer, timestamp, decision, optional commit SHA/config hash, comment, and optional A04 review-timer observation reference.
- Build Review surface with provenance, evidence, safe viewer, comments, A04's explicit timer, approve, and request changes.
- Preserve historical reviews while showing each newer version as unapproved.
- Connect review decision to result/task flow without conflating artifact approval with result acceptance.
- Ensure permission checks distinguish ordinary review from credential/capability/destructive approvals.
- Emit semantic activity and security audit facts without secrets.
- Show outdated evidence when Git/config/result bindings no longer match.

## Non-goals

- Approval inheritance, automatic result acceptance, merge/deploy permission, or editing artifact bytes.

## Work plan

1. Add immutable review migrations/commands and permission rules.
2. Build Review UI around the V02 viewer and consume A04's review-timer contract.
3. Integrate changes requested/outdated evidence with A03.
4. Test version replacement, concurrent review, permission boundaries, and historical display.

## Acceptance

- Review always references an exact version/hash and cannot mutate it.
- Publishing a new version leaves prior review historical and new version visibly unapproved.
- Artifact approval does not accept a result or grant launch/policy/credential authority.
- Concurrent/stale review decisions resolve through explicit version conflict.
- Review timer is human-controlled and stored separately from browser presence.
- Review duration comes from A04 observations; V03 does not implement a parallel timer store or interval calculation.
- Hostile artifact remains isolated throughout comments/review actions.

## Evidence and handoff

- Commit version/review fixtures, permission tests, timer evidence, and Review UI recording.
- G01 treats this immutable binding as the visual-review release proof.

## Risks and decisions

- Approval semantics must stay narrow. A friendly green check cannot silently authorize another object.

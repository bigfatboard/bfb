# ADR 0003 — Local MVP account-test scope

Status: Accepted by Timo, 11 September 2026

## Context

L01's daemon kernel passed its exact automated target, repository verification and IC-1 regression checks from a clean checkout on macOS. Its native fixtures use empty, isolated BFB state under the current GUI account. That evidence does not establish the original L01 requirement to install and inspect the daemon under a genuinely fresh macOS user account.

Timo approved continuing the local MVP after being asked to defer that account-level test to G02. This decision changes the timing of one environment acceptance check, not its result or the execution trust model.

## Decision

- L01's local MVP acceptance uses an empty private BFB state directory in the current unprivileged macOS GUI account, with real launchd installation, CLI health/log checks, process crash/restart, socket permissions and native-client tests.
- Move the genuinely fresh macOS account installation/status/logs check to G02's clean-Mac release certification. It remains untested and must not be described as passed, waived for release, or equivalent to the isolated-state fixture.
- Preserve L01's kernel peer-UID validation, private state permissions, secret-redaction, storage durability, non-destructive recovery and all negative tests. No safety assertion is removed from the automated target.
- Do not extend this exception to signed native Keychain access, enrollment, provider containment, cross-device proof, or any other package gate.

## Consequences

L01 can become `done` for the approved local MVP after clean-checkout certification and a committed evidence manifest for its revised scope. Dependent work may then proceed. G02 explicitly owns the deferred test and still must satisfy AG-10; the local MVP is not clean-machine release certification.

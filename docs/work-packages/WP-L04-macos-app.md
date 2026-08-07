# WP-L04 — SwiftUI macOS application

Status: `planned`

Risk: High

## Outcome

A thin native menu-bar app exposes runner status, browser pairing, wake intents, notifications, and safe Terminal opening while all BFB protocol logic remains in the daemon.

## Dependencies

- **Requires:** C06, L01, L08.
- **Unlocks:** G02, L05, W02, X01.
- **Can run with:** C09 after Local RPC and the wake-intent contract are frozen.

## Scope

- Show daemon, enrollment, workspace runner, and blocked-state status.
- Handle first-run/browser runner enrollment through L08 Local RPC without creating or reading a human CLI credential.
- Support managed-cloud Universal Links and self-host `bfb://` fallback with opaque, bounded, single-use cloud wake-intent IDs issued by C09.
- Forward a cloud wake intent to the daemon through `WakeIntent`; the app never claims the durable launch or creates the daemon-local Terminal intent.
- Register the menu-bar app for the interactive user session and let the daemon wake it on demand; report `app_unavailable` rather than stranding a claimed launch when no GUI app/session can respond.
- Provide native actionable notification primitives.
- Open Terminal.app with only the fixed installed absolute `bfb` path plus a validated daemon-local Terminal intent UUID supplied by L05.
- Report daemon unavailable, locked/login-window session, Automation consent denied, expired intent, and revoked runner.
- Establish development signing/Associated Domain tests; final notarization belongs to G02.
- Decode every Local RPC fixture published by F02 with the app's actual Codable models and reject the adversarial/unknown-version corpus consistently.

## Non-goals

- Human CLI credentials, durable command claim, daemon-local intent creation, cloud domain logic, checkout paths, provider flags/argv, embedded terminal, simulated keystrokes, or alternate terminal applications.

## Work plan

1. Prove Swift-to-UDS, shared wire-fixture decoding, daemon lifecycle independence, and status UI.
2. Implement runner pairing and distinct opaque wake-link/custom-scheme handling.
3. Implement Terminal opening and notification primitives.
4. Test duplicate intent sources, malicious links, locked sessions, and consent failure.

## Acceptance

- Universal Link/custom-scheme delivery produces only a bounded `WakeIntent` call to a fake daemon; L04 never claims a cloud command or Terminal intent. Duplicate deliveries preserve the same wake-intent identity for downstream idempotency.
- Paths, task text, shell metacharacters, and oversized link data are rejected before Terminal.
- The Terminal command contains only fixed app-owned BFB path plus a daemon-local Terminal UUID and never a cloud wake-intent value.
- Locked session and denied Automation consent report typed states without bypass.
- App termination does not stop the daemon or corrupt an active execution; the daemon can relaunch the app in an available GUI session or reports `app_unavailable`.
- The Swift decoder accepts/rejects the same Local RPC golden corpus as Go and never silently defaults an unknown required field.

## Evidence and handoff

- Commit UI/link tests, fake-daemon `WakeIntent` traces, Terminal command capture, cross-language Local RPC fixture results, and signed-development behavior notes.
- L05 may call only `OpenTerminal(terminal_intent_id)`; the app never receives provider configuration or a cloud launch specification.

## Risks and decisions

- Universal Links and Apple Events differ between development and signed distribution; both need repeatable gates.

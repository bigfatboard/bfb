# Native app and daemon bridge v1

Owner: [L04](../work-packages/WP-L04-macos-app.md). Exact gate: `pnpm test:l04`.

The SwiftUI app is a menu-bar client, not an execution owner. Closing it cancels its own polling tasks; it does not stop the daemon, claim a command, mutate a checkout, read a credential, or terminate an agent. The per-user Go daemon remains independent under launchd.

## Wire ownership

`pnpm protocol:generate` owns `apps/macos/Sources/BFB/WireGenerated.swift` together with the existing Go/TypeScript output. The generated Swift Codable models and embedded schema catalog are checked by `pnpm protocol:check`. `node tools/macos/fixtures.mjs` owns the `local-rpc.l04-*` fixtures and their matrix entries; `--check` is non-mutating. The app's actual decoder runs every Local RPC matrix fixture in XCTest.

The Swift transport sends a fresh ULID request ID, validates the complete schema before decoding or encoding, and checks reply ID/method/direction. It rejects unknown fields/versions, duplicate keys, malformed Unicode, non-integral or lossy numeric values, invalid calendars and schema bounds. Frames are compact newline-delimited JSON bounded to 64 KiB. Socket/root permissions and kernel UID/PID are checked. Cancellable non-blocking I/O has an eight-second total deadline and never runs on the UI actor.

## Enrollment and status

The app consumes L08's `runner.enroll`, `runner.list`, `runner.wake` and `runner.forget`. Enrollment accepts a user-selected HTTPS app origin, workspace ID and public Mac label. It opens only the daemon-returned `/runner-enroll` fragment on that same origin, bound to the requested workspace. Browser approval and passkey verification remain in C06/L08. No human CLI login or credential is created.

Connection status is labelled as a connection, not provider activity. Revocation, unavailable credentials, failed synchronization and authorization renewal remain distinct. `runner.forget` removes only an already-revoked local enrollment under L08's checks; it does not revoke cloud access or erase other workspaces.

## Opaque wake links

- Self-hosted fallback: `bfb://launch/<cloud-wake-ULID>`.
- Managed links: `https://<signed-associated-host>/l/<cloud-wake-ULID>`.
- Links are bounded to 512 UTF-8 bytes. Query/fragment data, credentials, ports, suffixes, encoding tricks, paths, shell text and unassociated hosts fail before native actions.
- The same identifier is forwarded from custom-scheme or browsing-web user-activity delivery. The app sends exactly `app.wake {wake_intent_id}`; the daemon's launch owner supplies its `WakeIntent` callback. Without that owner it returns `not_implemented`, never a fabricated acceptance.
- C09 owns issuance, principal/workspace/runner/device binding, expiry and single-use cloud semantics. Neither a wake link nor its local receipt claims a durable launch.

Managed hosts come from the app's verified code-signature entitlements, not a URL, a cloud response, user defaults or an arbitrary HTTP origin. Self-hosting does not dynamically broaden that list.

## Native action delivery

`internal/appbridge.Bridge` exposes `OpenTerminal(ctx, terminalIntentID)` and `NotifyAttention(ctx, notificationID)` to their owning daemon packages. It does not expose an RPC operation to create Terminal intents. The only app RPC operations are:

| Operation | Request | Response |
| --- | --- | --- |
| `app.wake` | Cloud `wake_intent_id` only | Empty acknowledgement or typed failure from the launch owner |
| `app.poll` | `app_session_state`: available, locked or login_window | Empty after at most two seconds, or one bounded delivery |
| `app.complete` | `app_delivery_id` and `app_result` | Empty acknowledgement or typed failure |

A Terminal delivery has exactly `app_delivery_id`, `app_action: open_terminal` and `terminal_intent_id`. A notification delivery replaces the Terminal ID with an opaque `notification_id` and uses `app_action: notify_attention`. Extra application-action fields are rejected even if they are valid in some other Local RPC operation.

The daemon limits pending deliveries to 32 and total delivery time to seven seconds. An offered delivery is never automatically re-offered. The signed peer's kernel PID binds acknowledgements; a bounded 256-entry receipt cache handles a lost acknowledgement response. If the app never received an offer, failure is `app_unavailable`; after an unacknowledged offer, it is `app_delivery_unknown`. The supervisor must reconcile the local single-use intent before retrying. This bridge's in-memory delivery state is not the durable launch ledger.

The app rechecks the console user, login completion and lock state before interactive work. macOS's current session dictionary supplies the console/login fields; the observed `CGSSessionScreenIsLocked` flag supplies the lock check. Unit injection covers state transitions; signed-device acceptance also records the actual observed state. A locked-device diagnostic run is not proof of the available-session path.

## Terminal and notifications

`TerminalIntentId` is a canonical lowercase UUIDv4, distinct from the cloud ULID. This freezes the architecture's UUID requirement for the previously unconsumed F02 Terminal placeholder. L05 creates and consumes that intent; it alone performs final authorization and validates the checkout/provider/lease.

Terminal receives one `core/dosc` Apple Event whose direct parameter contains only the shell-quoted, app-owned absolute `Contents/Helpers/bfb` path, the literal `__launch` subcommand and the validated UUID. The event targets only `com.apple.Terminal`; there is no AppleScript interpolation, provider argument transport, keystroke injection or alternate-terminal fallback. The helper and enclosing app signatures must be valid, hardened and from the same Apple signing team.

Native delivery does not prompt for Automation consent. The explicit **Enable Terminal access** control requests it separately, off the UI actor; denied or not-yet-granted permission returns `consent_denied`. Notifications similarly require explicit permission. Their title/body are fixed, carry no task content, and offer only **Open BFB**; a notification does not answer a question or launch a command. X01/A02 own later domain routing and notification policy.

## Signing, installation and relaunch

`pnpm build:macos` builds a fresh development-signed Release bundle with its embedded Go helper. It does not overwrite an existing bundle, install a service, change an Apple Developer account, notarize, or deploy. Move the whole bundle to a stable local location before using **Start runner**. The app then invokes only the verified helper's local `daemon install` operation. The daemon validates the signed sibling bundle before waking it through LaunchServices; no URL or execution argument is passed to that wake operation.

The local installer runs off the UI actor with a 15-second deadline and a 64-KiB output limit. It does not wait indefinitely for pipe EOF or expose raw subprocess output in the UI. Timeout stops only that installer and asks the user to check runner status before retrying; it does not stop an independently installed daemon or assert that no installation occurred.

App peers must satisfy the same Apple signing team as the signed daemon and the `com.qdis.bfb` identifier. Both components require hardened runtime and reject debugger/library-validation/DYLD-environment exceptions. The helper identifier remains `com.tenira.bfb.daemon`; runner Keychain ACLs remain daemon-owned under L08.

The default self-hosted build claims no restricted Associated Domains entitlement. Managed development links additionally require an eligible **Mac** provisioning profile for `com.qdis.bfb`, with Associated Domains authorized. Supply its local path as `BFB_MACOS_PROFILE` to the full acceptance gate; the build verifies the platform, application identifier, domain authorization and signing team, then embeds the profile. It never borrows an iOS profile or silently strips a requested capability after a signing failure. Apple describes the requirements in [Associated Domains](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.associated-domains) and [provisioning profiles](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles).

The development test uses `launch.bfb.example?mode=developer`, checks the signed entitlement/AASA application identifier, and directs an HTTPS URL to the built app. Public AASA/CDN discovery on an operator-controlled host and notarized release identities remain G02 environment work; an explicitly directed URL is not evidence of public Universal Link discovery.

## Verification status and prerequisites

The full L04 gate requires a matching Mac provisioning profile and an unlocked interactive login session. A separate diagnostic run is available with `BFB_MACOS_TEST_SELF_HOSTED=1 node tools/macos/acceptance.mjs`. The exact `pnpm test:l04` gate rejects that override; it cannot satisfy managed-link certification. A locked diagnostic run verifies live locked-state rejection, app-only quit, child-process/storage survival, native socket framing and signing negatives, but does not claim available-session relaunch or Terminal acceptance.

Current local investigation found no eligible Mac profile; macOS rejected the restricted build with `No matching profile found`. Existing iOS profiles are not a substitute. No Apple Developer account mutation has been made. The active Mac was locked during the initial native tests. These are recorded prerequisites, not passing L04 or release evidence.

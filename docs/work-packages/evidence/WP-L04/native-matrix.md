# L04 native acceptance matrix

Certified revision: `c1653e6d56d6d0029bc98270914c289a01d24a24`. Exact command: `pnpm test:l04`. All references below are synthetic fixtures, not user work.

| Boundary | Executable evidence | Observed outcome |
| --- | --- | --- |
| Wire parity | Actual Swift Codable decoder, Go and TypeScript shared matrix | All 39 Local RPC cases agree: 14 accepted, 25 rejected; all 185 protocol tests pass |
| Malformed framing | Native probe over real private Unix sockets | Partial frames accepted; wrong correlation/version/direction, duplicate keys, oversized frames, invalid UTF-8 and extra frames rejected |
| Local filesystem and peer identity | Signed app/helper plus hostile socket/probe fixtures | Public permissions, state-directory symlink, unauthorized peers and tampered helper rejected |
| Signing and managed host | Mac development profile, signed entitlement and AASA application-ID checks | Matching hardened signatures and explicitly configured host accepted; private-filesystem helper alias remains usable |
| Wake identity | OS-directed custom-scheme and HTTPS links | Both deliver the same opaque cloud ULID through `app.wake`; no cloud claim or Terminal intent is created |
| Link injection | UUID substituted for cloud ULID, query/suffix data, encoded metacharacters and unassociated host | No additional wake delivery; unit cases also cover oversized and malformed links |
| Terminal boundary | Fixed signed helper plus canonical local UUID; captured unit command and real synthetic helper receipt | Native `terminal_opened`; helper receipt confirms the UUID handoff; no provider arguments or cloud launch data enter Terminal |
| App lifetime | Three graceful app exits and daemon-driven relaunches | A new app process responds after each exit; daemon, owned child and stored observation survive |
| Denied access | Current unit injections and prior clean signed-device run | Typed locked/login-window and consent outcomes; earlier native denied-permission run also completes three relaunch cycles |
| Notifications | Fixed title/body/action, valid opaque reference, actual permission state | Current native delivery reports `notification_denied`; no task content or answer/launch authority is carried |
| Ambiguous acknowledgement | Bridge unit failures and observed Apple Event timeout | `app_delivery_unknown` is not completion; no automatic re-offer of an already offered delivery |
| Pairing and recovery | Model tests and native first-run visual review | Browser origin/workspace binding enforced; offline/revoked recovery is explicit; keyboard focus and scrolling remain usable |

## Bounded synthetic trace

The two native wake sources forward `01ARZ3NDEKTSV4RRFFQ69G5FAV`. The synthetic Terminal helper accepts only `e0da52a9-d0cb-47d8-867b-e08f684b9001`. The command shape contains the shell-quoted fixed signed helper, literal `__launch`, and that local UUID. These two identifier types cannot substitute for one another. The test helper deliberately permits repeat observations of its one synthetic UUID; L05, not this fixture, owns durable single-use intent consumption.

The final native run records one initial Terminal acknowledgement and three more across relaunch cycles. Its bounded receipt is `synthetic UUID handoff accepted`. Notification access remains denied. App/daemon test processes are cleaned up without closing unrelated Terminal windows or changing user work.

## Native UI and OS consent observations

The real menu/status window was inspected for first-run hierarchy, offline recovery, enrollment fields, visible keyboard focus and access controls reached by scrolling. The review corrected an aspirational connected heading, a recovery instruction pointing in the wrong direction, and a busy label that incorrectly implied every operation was enrollment. Those copy-only changes are included in the certified revision. No post-change screenshot is retained.

An intermediate explicit consent request did not produce an observed decision. A subsequent native run opened Terminal but its event timed out with `-1712`; it failed the gate rather than being counted as success. No macOS security setting was bypassed or reset. Timo then reported allowing access and starting Terminal, after which the unchanged certified revision passed the exact native gate. The precise system-dialog state was not independently observed.

## Scope limits

The HTTPS URL is directed to the signed application. This proves the signed-host and app handling boundaries, not public AASA/CDN discovery. Release signing/notarization and fresh-account installation remain G02 work. The current gate's actual GUI session is available; current injected tests cover locked/login-window states, with earlier signed locked-session diagnostics recorded separately. Real execution, final authorization and checkout/provider containment remain C09/L05 responsibilities. Permission-denied notification proof is not a claim of visible notification delivery.

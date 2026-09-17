# Human CLI credentials contract

C05 owns this server contract. X02 owns the CLI exchange client, Keychain
storage, and credential renewal UX. C09/L08/E01 must never accept a CLI
credential where a runner proof is required; a resolved CLI principal is not
a reusable credential and never becomes a web session.

## Device bootstrap

The CLI starts a `POST /auth/device/code` request with `{client_id:
"bfb-cli"}` and an optional scope subset of `bfb:read bfb:task:write`. Any
other client, a caller-supplied `user_id`, a wider scope, or an oversized
body fails. The response carries the RFC 8628 `device_code`, `user_code`,
verification URIs, a 10-minute expiry, and a 5-second poll interval. The
Better Auth `device-authorization` plugin owns these protocol rows in
`better_auth_device_codes`; BFB owns every authorization decision around
them. `POST /auth/device/token` is disabled and answers `404`: a device
code can never become a web session through the CLI path.

## Browser approval and the single exchange

The human opens the verification URI, selects a workspace and an optional
project subset, and the browser calls:

| Endpoint | JSON fields | Result |
| --- | --- | --- |
| `POST /api/v1/workspaces/:workspace/cli/authorize` | `user_code`, `project_ids` | `201 {binding}` |
| `POST /api/v1/workspaces/:workspace/cli/bindings/:binding/revoke` | `{}` | `{binding}` with `revoked_at` |
| `POST /api/v1/cli/exchange` | `client_id`, `device_code` | `{credential, binding_id, key_prefix, scopes, expires_at}` |
| `GET /api/v1/cli/session` | `Authorization: Bearer bfb_cli_…` | safe principal projection |

Approval first binds the device code to the browser session user, then the
`cli.authorize_device` hub command creates the `api_key_binding` for that
human, workspace, fixed scopes `["bfb:read", "bfb:task:write"]`, project
subset, expiry (30 days), and current authorization epoch. Only owners and
members may approve, and only within their current project access. One
bootstrap credential yields one pending binding across workspaces; a second
approval fails. The plugin approval follows; when it cannot complete, the
binding is revoked before any key exists, and a pending binding can never be
exchanged.

The CLI polls only the BFB exchange endpoint with its `device_code`. The
route mints `bfb_cli_` plus 32 random base64url bytes, and
`cli.exchange_credential` stores the SHA-256 hash, marks the binding
exchanged, and deletes the device row in one hub batch guarded by
`cli_mutation_guards`, so racing exchanges have one winner. The raw
credential is returned once and never enters D1, logs, URLs, or process
arguments. Only the key hash and the 12-character public prefix persist.

## Per-request authority and revocation

Every `GET /api/v1/cli/session` call — and every future X02 CLI route —
resolves the presented key against its binding, current workspace
membership, role, project access, and authorization epoch. Revoking the
binding disables authority in the same command that runs before device-row
cleanup; removing the member or bumping their epoch disables it through the
epoch fence without touching the binding row. Expired, unexchanged, revoked,
foreign-workspace, reviewer-demoted, and project-emptied credentials fail
with `unauthenticated`/`request_rejected` and no oracle detail.

CI keys use `integration` bindings with the same hash-only storage, but no
C05 route issues them: the browser endpoints create human bindings only, and
an integration credential can never impersonate a human.

## Credential separation

A CLI credential is accepted only on `/api/v1/cli/*`. Browser
(`/api/v1/*`, `/auth/*`), runner (`/runner/*`), MCP (`/mcp`), and webhook
(`/webhooks/*`) routes reject it; CLI routes reject cookies and browser
origins in return. No endpoint exchanges a CLI credential for a session, and
no direct key create/update route exists. Abuse budgets for issuance,
approval, polling, and exchange are D1-backed and keyed by hashed IP plus
hashed subject/code/client dimensions; rate keys and diagnostics contain no
raw user code, device code, IP, or credential.

## Keychain storage

The local client stores the raw credential in exactly one Keychain item:

- Class `kSecClassGenericPassword`, service `bfb-cli`, account
  `<workspace-id>`, accessibility after-first-unlock, device-only
  (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` or stricter).
- The item holds the full `bfb_cli_…` value; labels and comments carry at
  most the workspace ID and the public key prefix, never the credential.
- Deletion on sign-out, revocation sync, or workspace switch; no copies in
  logs, preferences, shell history, or process arguments.
- The runner private key and provider credentials keep their own Keychain
  items and access groups; the CLI item never shares them.

## Reproduction

- `pnpm test:c05` composes the build, protocol parity, focused domain and
  mounted route suites, and the two-isolate workerd run with exchange races,
  revocation, abuse exhaustion, and secret scans.
- Migration `0018_cli_credentials` owns the plugin device table and the
  binding/guards schema; the drift test fails on any unreviewed change.

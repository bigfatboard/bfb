# ADR 0012 — Explicit local pilot Hub jurisdiction emulation

Status: Accepted for implementation under the approved local-pilot scope, 6 October 2026. This is not L07 acceptance evidence.

## Context

The persistent local pilot uses stock Workers, D1, R2 and WorkspaceHub, with real GitHub authentication and passkeys. Its workspace records retain the deployment's configured `eu` jurisdiction. Pinned local Workerd rejects `DurableObjectNamespace.jurisdiction("eu")` with `Jurisdiction restrictions are not implemented in workerd.` before any Hub command runs. Existing project Workerd fixtures use `global` and did not exercise this boundary.

Changing a real workspace's jurisdiction or recreating its owner is not a fix. Production must continue resolving each workspace through its actual jurisdiction-specific namespace. A transport exception must never trigger process-local execution or an implicit global fallback.

## Decision

Add the explicit string-valued `LOCAL_HUB_JURISDICTION_EMULATION` setting, default `false`, permitted only when `ENVIRONMENT=local`. Enable it only in the dedicated pilot configuration.

When enabled, normalize the real WorkspaceHub binding once at the Worker entrypoint. Named EU and US workspaces resolve to deterministically distinct local DO names containing their logical jurisdiction and workspace identity. Global names remain unchanged. This uses real Durable Objects and the existing FIFO/D1 domain kernel; it emulates logical namespace isolation, not geographic placement or EU residency. The adapter supports the named-object operations needed by workspace routing and rejects unsupported scope/ID operations rather than guessing.

Fetch transports (REST, MCP, browser realtime, runner), Queue consumers and scheduled Hub commands all receive the same normalized binding. There is no competing lane or authority model. Without the flag, the existing native namespace routing remains unchanged and failures remain closed. Staging/production reject the emulation flag before serving.

## Verification and limitations

Unit regressions cover default-off behavior, malformed/non-local settings, deterministic jurisdiction separation, and rejection of cross-scope local IDs. A disposable real-Workerd regression covers the unsupported native EU call, real Hub project creation/retry/read under emulation, and unchanged strict failure without it. No test reads actual pilot secrets, inserts an actual owner, or mutates existing pilot data.

The pilot still needs its real authenticated browser-to-Mac flow. This fix does not certify deployed residency, providers, launch, or L07 completion. Local named IDs are deliberately different from production jurisdiction IDs; this is not a data migration path between local and deployed environments.

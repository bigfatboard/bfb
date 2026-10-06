# Agent-to-agent delivery research

As of: 5 October 2026. Status: research and proposed experiments, not provider certification or a new architecture decision.

## Scope and evidence

This note supports remote Claude/Codex start and human-initiated, read-only discussion under [ADR 0002](../adr/0002-human-initiated-discussions.md). It does not authorize runtime replacement, automatic worktrees, interactive-session takeover, credential extraction, or terminal keystroke transport. [The acceptance matrix](../work-packages/ACCEPTANCE.md#mvp-discussion-gates), package dependency closure, and exact clean-checkout targets remain authoritative.

Research used official documentation and public first-party source. No live model turn, paid capability experiment, private session inspection, or proprietary binary inspection was performed. Documentation describes capabilities; only exact-version BFB evidence can certify them.

| Inspected baseline | Version or immutable reference | Meaning |
| --- | --- | --- |
| BFB | `472f007e3f492dbde7affbd08389717edffbbf05` | Source snapshot for the integration gaps below |
| Installed Claude / Codex | `2.1.289` / `0.159.0`, measured 5 October | Installation observations, not discussion acceptance |
| BFB Claude / Codex manifests | `2.1.274`, `2.1.275` / `0.153.4` | Current adapter allowlists; newer versions cannot inherit certification |
| Public Codex source | [`687a119f0fcaace47e1f1abcc77cec6c813fd6da`](https://github.com/openai/codex/commit/687a119f0fcaace47e1f1abcc77cec6c813fd6da), release tag `rust-v0.159.0`, 29 September | Matches installed version string, not verified binary build provenance |
| T3 Code | [`3e6b45028ceec5820dacb37dc3852470ebdc9411`](https://github.com/pingdotgg/t3code/commit/3e6b45028ceec5820dacb37dc3852470ebdc9411), 5 October; server `0.0.45` | Source comparison; lockfile resolves Claude Agent SDK `0.3.276` |
| OpenCode | [`907b3bc518fa48e90e8ec24dd327d13eee71c36c`](https://github.com/anomalyco/opencode/commit/907b3bc518fa48e90e8ec24dd327d13eee71c36c), 3 October; `1.18.34` | Source comparison, not a replacement execution runtime |

## Observations: provider mechanisms

### Codex

Internal subagents are owned by the Codex runtime: it spawns agents, delivers follow-ups, waits, and closes them. Their permissions inherit the parent boundary and may be narrowed. This does not establish an external API for messaging an arbitrary independent CLI session. [Official subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents).

`codex exec` is the stable scripting route. JSONL exposes `thread.started.thread_id`; the documented `turn.started` / `turn.completed` examples do not expose a native turn ID. Exact `codex exec resume <SESSION_ID>` is supported; BFB must not use `--last`. Saved CLI authentication is reused. The documented combination of a fixed prompt and piped additional context is useful for ADR 0002's fallback, but it is not a documented native lower-authority peer-message role. [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [CLI commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

App-server has richer correlation: `thread.id` identifies the thread, `thread.sessionId` identifies the live session-tree root, and forks retain that root. `turn/start` returns `turn.id`; completion distinguishes completed, interrupted, and failed. Steering requires `expectedTurnId`. These IDs must remain separate. Default stdio uses JSONL plus initialization; WebSocket is a distinct transport. The app-server command itself is experimental and not supported for production workloads; stdio does not remove that limitation. [App-server protocol](https://learn.chatgpt.com/docs/app-server), [feature maturity](https://learn.chatgpt.com/docs/feature-maturity).

App-server's documented `toolOutput` retains function-output semantics and can queue into an active turn. `thread/inject_items` persists raw history without starting a turn; the caller chooses roles, so it is not inherently a safe external-message boundary. Neither should be advertised as a stable arbitrary-sender A2A primitive. [App-server input and history APIs](https://learn.chatgpt.com/docs/app-server).

The current SDK page documents TypeScript local threads and a stable Python SDK controlling a local app-server. Stable SDK status does not make every underlying command/transport production-stable. The changelog contains agent message-board implementation work, including persistence, collaboration tools, remote-board clients, and notification handling; it does not by itself specify an external sender contract with ownership, acknowledgement, and deduplication guarantees. [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), [changelog](https://learn.chatgpt.com/docs/changelog).

The older `github-release-386577294` changelog pointer previously used for external-message claims could not be re-established from the current documentation. This is **unverified**, not proof of removal. Native external-message or message-board use needs a current method/schema, maturity statement, and exact-version fixture before it becomes a capability.

#### How the public Codex runtime implements collaboration

The pinned `0.159.0` source shows a runtime-owned Rust control layer, not terminal input simulation:

- Spawn reserves runtime capacity, creates a child thread with inherited environment/policy, and persists its parent edge before initial input. Ownership-validated reload rejects inconsistent parent ownership. [Spawn implementation](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/agent/control/spawn.rs#L630), [reload ownership](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/agent/control/spawn.rs#L311).
- `send_message` uses `QueueOnly`; the shared follow-up path uses `TriggerTurn`. The control layer resolves registered caller/target identities and returns a submission receipt, not completed model work. Plaintext messages become attributed `InterAgentMessage` fragments with **assistant**, not user, role. This establishes an internal lower-authority representation, not a supported way for BFB to inject that internal operation. [Send handler](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/tools/handlers/multi_agents_v2/send_message.rs#L39), [control dispatch](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/agent/control/api.rs#L100), [message role](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/context/inter_agent_message.rs#L45).
- `wait_agent` waits for mailbox/steering activity under a bounded timeout; a successful wait is not proof that another task completed. [Wait implementation](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L39).

The message-board client has a public HTTP/SSE backend contract scoped to one agent tree. The launcher supplies session identity/credentials and membership; receiving-turn validation prevents notifications from waking finalized agents. The crate supplies no server. These are inspectable implementation contracts, not documented stable CLI external-sender interoperability. [Client README](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/agent-message-board-client/README.md), [host authority and notification lifecycle](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/ext/agent-message-board/src/host.rs#L17).

### Claude Code

Cross-session messaging is native communication between independent **Claude Code** sessions. `ListAgents` and `SendMessage` discover/send plain-text peer messages; they do not expose complete histories. Same-machine support across authentication/model backends means Claude backends such as Bedrock or Vertex, not Claude↔Codex interoperability. Native peer content does not confer human approval and recipient permissions remain in force. [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging).

Claude's implementation is closed; the claims here are published documentation observations, not an inspection of its internal code.

That page explicitly permits scripts/hooks to post to a session's local socket and documents socket discovery, per-session authentication, and connection constraints. It does not provide a complete external message payload schema or a durable sender/turn-correlated receipt contract. Delivery happens between tool calls or starts an idle turn; held, refused, and delivered differ. Bounded queues, expiry, throttling, and short-window duplicate suppression are not durable exactly-once delivery. Non-bare print sessions have an inbox; bare sessions do not. [External socket and delivery sections](https://code.claude.com/docs/en/cross-session-messaging).

Headless CLI output supplies `session_id` and exact `--resume`. Stream input with `--replay-user-messages` echoes accepted user input; this acknowledgement is not correlated turn completion. A structured result, session identity, error status, and owned process lifecycle need separate normalization. Since `2.1.285`, resuming a live background session can attach and forward the prompt rather than reject it; BFB must reject busy/unowned targets before invocation. [Headless mode](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference).

Read-only is not achieved with `dontAsk` or an instruction alone. `--tools` limits built-ins, not MCP. Current `--restricted` removes command/code execution and WebFetch by default, confines file tools, and narrows settings; individually re-enabling tools can weaken it. `--safe-mode` disables customizations while preserving normal auth, but managed policy hooks/status-line/file-suggestion commands still apply. Verify the intersection of tool, MCP, hook, settings, filesystem, and permission boundaries. `--bare` is not a subscription-preserving isolation substitute: it skips subscription OAuth/system keychain. [CLI flag definitions](https://code.claude.com/docs/en/cli-reference), [bare behavior](https://code.claude.com/docs/en/headless).

Agent teams are experimental runtime-owned coordination and do not restore in-process teammates on resume; print/SDK teammate spawning is not supported. Channels are a research-preview MCP push mechanism with additional authentication/allowlist constraints. Neither is required for this MVP. [Agent teams](https://code.claude.com/docs/en/agent-teams), [channels](https://code.claude.com/docs/en/channels).

### Authentication is a separate decision

Standard Claude Code supports the user's normal subscription, Console, and supported cloud-provider authentication. The Agent SDK documentation separately restricts third-party products offering claude.ai login/limits without prior approval. That SDK restriction is not, by itself, proof that locally invoking a user-owned standard CLI requires migration to API keys. BFB should not adopt the SDK or copy provider credentials; product/auth eligibility needs explicit review if that scope changes. [Claude authentication](https://code.claude.com/docs/en/authentication), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview).

Similarly, Codex CLI reuse of saved authentication is distinct from app-server authentication modes and their commercial/hosted restrictions. Experimental external-token modes are not a reason to extract tokens. Keep credentials in provider-owned local stores and do not expose an app-server listener through BFB's cloud control plane. [Non-interactive authentication](https://learn.chatgpt.com/docs/non-interactive-mode), [app-server authentication and transport](https://learn.chatgpt.com/docs/app-server).

## Observations: reusable public implementation patterns

### T3 Code

`sendToThread` derives target scope, checks a live caller and mode ceilings, constructs stable application message/command IDs, and returns application run status **separately** from delivery. This is an application-owned cross-provider coordinator, not evidence that Claude or Codex natively discovers the other. The useful pattern is scoped authority and distinct application/provider identities. [Pinned implementation](https://github.com/pingdotgg/t3code/blob/3e6b45028ceec5820dacb37dc3852470ebdc9411/apps/server/src/mcp/OrchestratorMcpService.ts#L1995), [correlation design](https://github.com/pingdotgg/t3code/blob/3e6b45028ceec5820dacb37dc3852470ebdc9411/docs/orchestration-v2/entity-ids-and-correlation.md).

`NotificationMailbox` explicitly accepts at-least-once delivery after an ambiguous acceptance receipt; reusing a message ID prevents duplicate timeline items, not necessarily duplicate model effects. Do **not** copy that retry policy into BFB. Context handoff code instead persists injection state and treats ambiguity as requiring a fresh native thread; BFB's exact-session policy should visibly pause rather than silently replace a session. [Mailbox](https://github.com/pingdotgg/t3code/blob/3e6b45028ceec5820dacb37dc3852470ebdc9411/apps/server/src/orchestration-v2/NotificationMailbox.ts#L3), [handoff recovery](https://github.com/pingdotgg/t3code/blob/3e6b45028ceec5820dacb37dc3852470ebdc9411/apps/server/src/orchestration-v2/ContextHandoffDelivery.ts#L10).

The Claude adapter reports no native turn ID and weak identity, while its read-only policy combines a read-tool allowlist with permission settings. Its compatibility parsing is implementation evidence, not an official CLI event guarantee. The Codex adapter uses app-server over child-process stdio and falls back from history injection only for known unsupported methods, not ambiguous transport errors. Borrow defensive normalization and unsupported/ambiguous distinctions, not T3's SDK/runtime/auth choices. [Claude adapter](https://github.com/pingdotgg/t3code/blob/3e6b45028ceec5820dacb37dc3852470ebdc9411/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L181), [read-only policy](https://github.com/pingdotgg/t3code/blob/3e6b45028ceec5820dacb37dc3852470ebdc9411/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L1501), [Codex history injection](https://github.com/pingdotgg/t3code/blob/3e6b45028ceec5820dacb37dc3852470ebdc9411/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L3648).

### OpenCode

OpenCode owns its model/session harness; it is not transport into existing Claude/Codex CLI sessions. Its HTTP asynchronous prompt route forks processing and returns `204` before completion. Explicit session/message IDs and event consumption are useful patterns, but incoming prompts are user-role messages, not native lower-authority peer input. [Server API](https://opencode.ai/docs/server/), [pinned async handler](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts#L311), [message creation](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/prompt.ts#L635).

Its runner map prevents overlapping local session loops but is in-memory, not durable multi-process fencing. Task continuation can create a new child session when lookup of `task_id` fails; BFB must not copy that fallback. Parent session restrictions constrain subagents, but named `plan`/`explore` agents are not hard read-only sandboxes: plan permits plan-file edits and explore permits Bash. [Runner state](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/run-state.ts#L35), [Task continuation](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/tool/task.ts#L136), [subagent permissions](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/agent/subagent-permissions.ts#L5), [agent defaults](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/agent/agent.ts#L156).

## BFB integration gap at the inspected commit

- [Claude's adapter](../../internal/providers/claude/adapter.go) intentionally rejects `Turn`; neither installed `2.1.289` nor its discussion isolation is certified.
- [Codex's adapter](../../internal/providers/codex/adapter.go) plans fresh/resumed/forked headless turns only for `0.153.4`; current documentation and installed `0.159.0` cannot retroactively certify those invocations.
- [Daemon composition](../../cmd/bfb/main.go) registers `launch` and `run_control` consumers, not `discussion_turn`. Existing [discussion delivery components](../../internal/discussion) and synthetic tests are not an operating end-to-end discussion path.
- [A01's handoff](../work-packages/WP-A01-local-mcp-context.md#handoff) records the remaining runtime work-transport seam. Connect and verify this run-scoped bridge before provider discussion experiments. [D02](../work-packages/WP-D02-discussion-delivery.md) remains `planned`; package-local implementation/evidence does not waive unfinished dependencies or DG-02.

## 6 October runtime reconciliation

The integration-gap observations above retain the inspected 5 October source
baseline. A01's missing bridge has since been connected and clean-certified at
`adbf740` ([runtime evidence](../work-packages/evidence/WP-A01/runtime-manifest.json));
A02's attention lane is clean-certified at `891fbcc`
([runtime evidence](../work-packages/evidence/WP-A02/runtime-manifest.json)).
A03's protected MCP/CLI result runtime is connected at `9077a08` and undergoing
its own clean certification. These changes satisfy the A01 synthetic runtime
prerequisite below, not current-version provider isolation, model-backed
discussion or Terminal acceptance. D02 still lacks the production scheduler/
consumer/Claude-turn path. No new provider experiment or external research was
performed by this reconciliation.

## Recommendation: ordered bounded acceptance experiments

Keep the Go runner, D1/WorkspaceHub commands, owned CLI processes, and ADR 0002 boundaries. Start with stable CLI continuation plus a fixed trusted instruction and attributed bounded peer context. Native delivery remains optional; neither app-server transport nor a new SDK/runtime becomes a production dependency through this research.

The following are proposed checks, all **not run by this research**:

1. **Runtime prerequisite.** Complete the A01 online run-scoped context bridge and supervised synthetic fixture harness. Prove assignment/session scope, revocation, stdout purity, and no reusable cloud credential before model-backed tests.
2. **Exact-version isolation.** Pin observed binary identity/version/configuration; capture fresh/headless capabilities and initialization metadata without general config edits. Test Claude safe/restricted modes, managed hooks, inherited MCP, built-in tools, and Codex read-only/approval/config overrides. Write attempts, unapproved shell/network effects, permission escalation, and peer-selected tool negatives must fail closed. Provider authentication/model traffic and permitted run-scoped context access are separate from unapproved tool effects. No API-key migration or auto-upgrade is implied.
3. **Fresh identity and exact resume.** Create two BFB-owned synthetic sessions. Preserve observed IDs across continuation; reject missing, changed, wrong, unowned, and busy sessions without most-recent or fresh-session fallback. Test local guards and durable fencing, including two workers and restart. Serialize same-checkout participants.
4. **Acknowledgement versus completion.** Normalize enqueue, provider input acceptance, running turn, terminal result, interruption, failure, and process end independently. Test Claude replay echo and malformed/error results; test Codex CLI's session identity without inventing a native turn ID. Persist BFB message/attempt/turn IDs and bounded structured outputs before advancing the scheduler.
5. **Bounded discussion and authority.** Independent initial positions, then sequential challenges/revisions: three rounds, at most six participant turns. Enforce deadlines, cancellation, current authorization, body/output bounds, and token budgets only where supported. Malicious peer text cannot alter permissions, roster, trusted instructions, context revision, or task state. Preserve disagreements; only a typed human decision concludes the human workflow.
6. **Crash and replay.** Inject failure before dispatch, after possible provider acceptance, after output, and before local/cloud commit. Duplicate/out-of-order events must have one business effect. Reconcile a possible model effect or pause visibly; never blindly resend merely because an acknowledgement is missing. Cancellation/revocation stops future turns and owned work without releasing uncertain process guards.
7. **Optional native primitives, then integration.** Only after the fallback passes, separately investigate complete Claude socket sender/receipt semantics and current Codex external-message/message-board schemas. App-server stdio can be an isolated non-production experiment; WebSocket remains separately experimental. Finish with browser→runner→Claude/Codex, human intervention, reconnect, and decision tests under DG-01–03 and `pnpm test:mvp-discussion`.

Retain bounded synthetic fixtures and redacted outcomes with exact commit, provider/tool versions, schema/configuration hashes, command, and `not_run`/`failed`/`passed` disposition. Do not retain credentials, private prompts, transcripts, or local absolute paths. A documentation claim or manual happy path cannot advance package status.

### Exact-version certification pitfalls

The read-only adapter follow-up found two concrete assumptions to test before enabling the installed versions:

- **Codex identity.** [Hook normalization](../../internal/providers/codex/events.go) stores hook `session_id` in the same session field that exec normalization fills from `thread.started.thread_id`. Official hook documentation says subagent hooks carry the parent session ID; app-server distinguishes thread ID from the session-tree root retained by forks. Prove fresh-root and exact-root-resume identity equality in fixtures. Do not infer fork/subagent support from that proof or conflate their identities. This is a risk inferred from the differing contracts, not an observed failure of a live BFB run. [Hook input](https://learn.chatgpt.com/docs/hooks#common-input-fields), [thread identity](https://learn.chatgpt.com/docs/app-server#start-or-resume-a-thread).
- **Claude isolation.** Safe mode disables ordinary hooks and MCP, including policy-configured MCP, while managed policy hooks/status-line/file-suggestion commands remain active. Restricted mode does not load ordinary user settings unless explicitly supplied. Therefore BFB's existing user-level registration is insufficient evidence that its binder hook and sole approved stdio MCP survive an isolated discussion launch. Prove a BFB-only configuration that retains normal authentication; bare mode is not a subscription-preserving substitute. [CLI flags](https://code.claude.com/docs/en/cli-reference#cli-flags), [bare mode](https://code.claude.com/docs/en/headless).

The smallest proposed model-backed proof is six bounded turns across two fresh synthetic sessions (one independent initial turn and two exact continuations each), plus at most one interruption attempt per provider. First check exact binary/configuration identity and isolated startup; startup can execute hooks and is not harmless discovery. Keep wrong-session, busy-owner, fencing and crash permutations in the deterministic process harness. Interactive Terminal ancestry requires a separate supervised native-UI check. Neither provider commands nor model/UI experiments were run in this follow-up.

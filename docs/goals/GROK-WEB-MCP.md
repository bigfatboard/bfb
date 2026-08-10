# Goal: Ship the BFB web + remote MCP control-plane slice

Work autonomously until this goal is complete and verified. Do not stop between packages merely to report progress. Advance only through the package gates below.

## Starting point

The repository is `/Users/timo/work/tenira/bfb`.

Start only after F01 is `done` on `main` and [ADR 0001](../adr/0001-web-and-remote-mcp-first.md) is present. Before editing:

1. Read every applicable `AGENTS.md` completely.
2. Read [ARCHITECTURE.md](../../ARCHITECTURE.md), [the roadmap](../work-packages/README.md), [the acceptance matrix](../work-packages/ACCEPTANCE.md), [the package template](../work-packages/TEMPLATE.md), ADR 0001, and every package in the execution sequence.
3. Inspect the implementation and every consumed/produced contract. Do not design from package summaries alone.
4. Confirm the worktree is clean, `pnpm verify` passes, and your feature branch was created from current `main`.
5. Record reasonable assumptions and proceed. Stop only for the decision conditions below.

The goal is the first web/MCP checkpoint, not the rest of v0.1.

## Terminal outcome

The goal is complete only when:

- An authenticated human can select a workspace, navigate permitted projects, and manage permitted tasks, context, comments, and agent proposals in the BFB web app.
- The board uses horizontal project lanes and a cross-project `Needs <current human> Now` deck. Project identity, task priority, current state, human attention, agent work, human work, and waiting time are visually distinct.
- The board never invents realtime state, progress, review, human work, agent work, time, tokens, or completion.
- A conforming approved MCP `2026-07-28` client can complete OAuth authorization and call the explicitly delegated BFB tool subset at `/mcp`.
- Claude, Codex, and Grok compatibility is tested and reported separately with exact client versions and limitations; an unsupported vendor client does not justify weakening the current protocol or transport.
- Web and MCP mutations reuse the same domain commands and authorization rules.
- Tenant, project, task, context-audience, credential-type, delegation, stale-version, idempotency, revocation, protocol-routing, and abuse-control boundaries fail closed.
- Every package in the sequence is `done`, committed, and has clean-checkout evidence at its declared path.
- The IC-1 web/MCP checkpoint and every earlier check pass from a clean checkout.

Do not continue into the Mac runner, local agent execution, provider hooks, realtime presence, attention resolution, result acceptance, measurements, artifacts, GitHub, or release hardening.

## Execution sequence

Complete one package at a time in this order:

1. F02 — Wire contracts and test doubles
2. F03 — Cloudflare application substrate
3. F04 — D1 tenant persistence and migrations
4. C01 — WorkspaceHub command and event kernel
5. C02 — Human identity and sessions
6. C03 — Passkey enrollment and action-bound step-up
7. C04 — Workspace authorization
8. C07 — Projects, repository identity, agent profiles, and policy
9. C08 — Tasks, runs, context, comments, and transport-neutral agent commands
10. W01 — Authenticated app and Work surface
11. X03A — Remote OAuth MCP core

F02 and F03 could run in parallel, but use this sequential order. Do not modify or prepare a later package while the current package is incomplete. Read-only inspection of a downstream consumer is allowed when needed to freeze the current contract.

## Package gate

For every package:

### Ready

- Confirm every direct dependency is `done`.
- Freeze explicit, versioned consumed and produced contracts.
- Assign one stable root test target and one repository-relative evidence manifest.
- Make every acceptance criterion executable, including negative cases.
- Run the previous checkpoint before editing.
- Resolve architecture/security decisions in an ADR.
- Move the package to `ready` and regenerate the roadmap.

Do not weaken acceptance to make a package ready.

### Implement

- Move the package to `in_progress`.
- Write the smallest failing test or executable fixture first.
- Implement only the package scope.
- Reuse domain commands; web and MCP do not own parallel business logic.
- Keep schemas and migrations limited to current consumers.
- Preserve naming, comment, and two-line `ABOUTME:` rules.
- Do not add speculative abstractions, backward compatibility, configurable workflows, or adjacent cleanup.
- Find root causes; do not stack workarounds or disable checks.

### Verify

Run the package test target, every affected earlier checkpoint, generated-contract and migration drift checks, named authorization/failure cases, and the clean-checkout procedure from F01.

The evidence manifest records:

- tested commit;
- protocol/schema versions and migration head;
- exact dependency/tool versions;
- environment and reproducible command;
- outcome and stable redacted evidence paths;
- redaction status.

Evidence contains no cookies, tokens, OAuth codes, secrets, prompt/task bodies, raw hook data, private terminal content, or local absolute paths. Synthetic fixtures are visibly labelled synthetic.

### Handoff

- Move through `review` to `done` only when acceptance is green.
- Regenerate the package graph/index.
- Record commands, contracts, migrations, fixtures, evidence, and genuine limitations.
- Commit one coherent package handoff before starting the next package.
- Inspect `git status` before staging.
- Push the assigned feature branch when safe. Do not merge, deploy production, or mutate other shared production state without Timo approving a rollout plan.

A package is not `done` when a test is skipped, evidence is missing, a check is flaky/manual-only, or downstream work still requires private knowledge.

## Cloudflare boundaries

- Use React/Vite through Workers Static Assets, a Hono Worker, D1, and one `WorkspaceHub` Durable Object per workspace.
- D1 is canonical persistence.
- Every workspace mutation commits through `WorkspaceHub` serialization with authorization, optimistic versioning, idempotency, a semantic event, and D1 constraints as backstops.
- Browser, API, authentication, and MCP stay same-origin.
- Do not create a Durable Object for MCP transport sessions.
- Use official Cloudflare and Better Auth documentation for unstable APIs. Pin compatible versions exactly; never install an unbounded `latest`.
- Do not introduce Pages, a second API service, an external database, or a second event authority.

## MCP 2026-07-28 boundaries

X03A implements current MCP `2026-07-28`.

- Serve stateless Streamable HTTP at `/mcp`.
- Use Cloudflare Agents SDK v2 `createMcpHandler(..., { legacy: "reject", allowedHostnames, corsOptions })` from `agents/mcp/server` with a fresh MCP server for every request.
- Derive `allowedHostnames` from F03's validated canonical host configuration. Permit native requests without `Origin`; when `Origin` is present, require the exact configured app origin. Configure non-credentialed CORS explicitly and reject arbitrary Host, opaque/null Origin, and every other origin.
- Do not use `McpAgent`, `createLegacyMcpHandler`, the legacy GET-based HTTP+SSE transport, persistent MCP sessions, sticky routing, or an MCP Durable Object. Request-scoped SSE permitted by current Streamable HTTP is not legacy transport.
- Do not implement or expect `initialize`/`initialized` or `Mcp-Session-Id`.
- Enforce `MCP-Protocol-Version: 2026-07-28` and `Mcp-Method`. Require `Mcp-Name` for `tools/call`, `resources/read`, and `prompts/get`; allow it to be absent for methods such as `server/discover` and `tools/list`. Missing required, unsupported, or body-mismatched routing metadata fails closed.
- Add fixtures for required and omitted `Mcp-Name` by method and every header/body mismatch.
- Use `server/discover` only through supported SDK behavior; do not recreate the protocol manually.
- Protocol state is stateless. Application state is explicit BFB state in D1/WorkspaceHub.
- Reject legacy protocol behavior unless a later approved ADR adds compatibility.
- Pin Cloudflare Agents and MCP SDK versions in the lockfile and evidence.

Use the official [MCP release](https://blog.modelcontextprotocol.io/posts/2026-07-28/), [Cloudflare handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/), and [transport documentation](https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/) when details are uncertain.

## OAuth and delegation boundaries

- Use authorization code flow with PKCE S256, exact redirect URIs, issuer/resource validation, rotating refresh tokens, and opaque hashed token storage.
- Create a BFB delegation before a token becomes active.
- Require a fresh C03 proof bound to client, resource, workspace/project/task boundary, scopes, expiry, and authorization epoch before creating or widening a delegation. Test stolen-cookie, stale/replayed, cross-client/resource/boundary, and scope/expiry-widening failures.
- Bind human sponsor, client, workspace, optional project/task boundary, scopes, expiry, and revocation epoch.
- Re-evaluate delegation, membership, project access, scope, resource, boundary, and epoch on every call.
- Derive authority from the authenticated delegation. Caller IDs may narrow it, never widen it.
- Support only server-preregistered public clients. Do not add Client ID Metadata Documents or a custom discovery layer against Better Auth internals in this goal.
- Do not expose open DCR, end-user client administration, `client_credentials`, bearer JWT access tokens, or service-account authority.
- A real C02 browser cookie cannot authenticate `/mcp`; synthetic reserved-format fixtures cover CLI, runner, integration, and local-agent credential classes that do not exist yet. The real cross-credential matrix remains SG-01/G01 work.
- MCP credentials cannot authenticate browser routes. Do not claim rejection against an unimplemented credential verifier as a real integration result.
- Revocation blocks the next call before token cleanup completes.
- Bound and D1-rate-limit authorization, token, and MCP surfaces.
- Never log authorization codes, tokens, request bodies, or private task context.

## X03A tool boundary

Expose only the smallest useful delegated loop:

- list delegated projects with `bfb_list_projects`;
- list/read delegated tasks with `bfb_list_tasks` and `bfb_get_task`;
- read the agent-visible context version with `bfb_get_context`;
- add a bounded comment or progress update with `bfb_add_comment` or `bfb_report_progress` through C08;
- create a proposed root task or policy-permitted child task with `bfb_propose_task`;
- return the committed result directly from every idempotent mutation.

Do not expose workspace administration, policy changes, passkey actions, runner launch/control, attention resolution, result acceptance, measurements, tokens, artifacts, GitHub, or deployment.

Collections are bounded and paginated. Mutations use idempotency and optimistic version checks. Agent-created root work remains `proposed`; a remote client cannot promote or accept it.

## Truth and attribution

BFB distinguishes:

- the human whose grant authorized the action;
- the authenticated MCP client;
- an optional client-reported provider/agent label;
- a verified local process or run identity;
- the source and provenance of time/token data.

An MCP request proves recent activity by an authorized client. It does not prove an autonomous agent is currently working.

Example copy, parameterized from the authenticated human and configured provider profile:

- `<provider> client via <human>'s grant · MCP activity 18s ago`
- `<provider> via <human>'s delegation updated this task`
- `Agent work unavailable`

Forbidden without later run-bound hooks or credentials:

- `Grok is working`
- `Claude completed this`
- `5 agents active`
- agent time inferred from request timestamps;
- human work inferred from an open browser tab;
- tokens inferred from request size;
- review or acceptance inferred from a comment.

Until E02/A02/A03/A04 exist, there is no realtime badge, attention resolution, result acceptance, or fabricated human/agent time/token total. Synthetic demo data is allowed only in committed test/demo fixtures and is labelled synthetic.

## Board contract

- Horizontal lane means project, never status.
- A top `Needs <current human> Now` projection shows at most three persisted P0/P1 blocking-or-due requests and links to their canonical cards.
- Project identity uses a stable tint, swatch, and full-width 3px card top edge. It never uses a side stripe.
- Priority is a separate fixed top-right marker.
- Every card has one neutral `NOW` label and a strong one-line punchline derived from committed semantic state.
- Show `Why <human>` when a person is explicitly required and `Why delegable` when policy allows a named handoff.
- Provide `Pass to <configured agent profile>` only when policy permits it; `Pass to Codex` and `Pass to Grok` are examples, not hard-coded profiles.
- Order the attention deck and each project lane deterministically.
- Keep agent work, human work, waiting, and token provenance separate; render precise unavailable states until measurements exist.
- Escape strings and use one reviewed Markdown renderer with raw HTML disabled. Artifact execution/viewing is outside this goal.
- Preserve accessible keyboard use and responsive behavior.
- Do not add configurable columns, drag-created state changes, health/utilization scores, or Jira-scale workflow configuration.

If persisted domain data cannot support an element yet, show an honest empty/unavailable state.

## Stop conditions

Continue through ordinary implementation decisions and failures. Stop and give Timo a concise, evidence-backed decision request only if:

- two valid choices materially alter an architecture or security invariant;
- a required package/ADR is absent or contradictory;
- a migration would destructively rewrite committed data;
- completion requires production/shared-state deployment;
- a dependency API cannot satisfy a frozen contract without changing package ownership;
- a required external credential/account cannot be provisioned with available tooling.

Do not ask Timo to run commands, edit files, configure the environment, commit, push, or gather logs.

## Completion report

Report:

1. F02 through X03A with status, commit, test command, and evidence path;
2. final protocol/schema versions and migration head;
3. exact clean-checkout verification command and result;
4. end-to-end web/MCP smoke procedure and result;
5. tenant, role, delegation, revocation, routing, and credential-confusion negatives;
6. per-provider Claude, Codex, and Grok compatibility with exact client versions, supported/unsupported status, and evidence;
7. browser evidence for owner/member/restricted-member fixtures;
8. exact remaining limitations without presenting later packages as implemented;
9. the next package now unblocked.

Do not declare success because a dev server starts, a screenshot looks correct, or one MCP tool call succeeds. The package chain and end-to-end negative paths must be green.

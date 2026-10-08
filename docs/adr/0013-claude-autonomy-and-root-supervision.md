# ADR 0013 — Explicit Claude autonomy and root-process supervision

Status: Accepted for implementation following Timo's approval on 6 October
2026. This records the revised contract, not passing implementation or live
provider acceptance. L07 remains the active package.

## Context

The private Claude pilot reached a real provider process and trusted local
session observation, then closed MCP because observed descendants belonged to
other process groups. Their executable identities were not captured before
they exited. Independently, Claude's documented command-hook contract and the
installed candidate's implementation establish that hooks deliberately create
separate sessions. A single-process-group requirement is incompatible with
that supported behavior. Permission bypass does not change this process model.

The existing process poller cannot prove a complete detached process family:
a short-lived parent can disappear between observations and leave an orphan.
Darwin's kqueue `NOTE_TRACK` family is unsupported. Observed ancestry is useful
evidence, but is not lossless process ownership or a macOS sandbox.

The existing Claude adapter also forces manual permission prompts. Timo has
explicitly requested autonomous launches using `--dangerously-skip-permissions`.
Bypass must not be described as a workspace filesystem boundary.

## Decision: explicit permission profile

- Add `permission_mode: manual | autonomous` to current and immutable profile
  records, defaulting existing profiles to `manual`. Keep `harness_mode` and
  its existing restricted/standard meaning unchanged.
- Initially permit autonomous mode only for interactive, standard Claude
  profiles. Restricted, headless, and other-provider combinations reject it.
- An autonomous snapshot uses `approval_policy: never` and
  `filesystem_policy: full_access`, requiring both advertised capabilities.
  It maps to the actual `--dangerously-skip-permissions` flag on launch and
  exact-session resume. Manual profiles retain their existing mapping.
- Existing workspace/project/repository provider and launch ceilings, named
  runner grants, immutable snapshot hashing, pre-exec validation, and local
  capability intersections remain mandatory. Creating or changing the mode is
  an owner profile operation, not a run override or automatic escalation.
- Label autonomous mode as full access available to the local OS user, subject
  to OS and provider-managed restrictions. It does not grant BFB cloud roles,
  new run boundaries, credentials, or deployment approval.
- Only the exact-pinned experimental candidate may initially advertise this
  mapping. Historical production provider certifications do not inherit it.

### Bounded prerelease wire exception

For this unreleased private pilot, explicitly supersede the blanket enum rule
in `protocol/docs/compatibility.md` for exactly two additions:
`filesystem_policy: full_access` and inventory capability
`filesystem.full_access`. Keep the existing document version and every old
value's meaning unchanged. This is a capability-gated, coordinated prerelease
extension, not general permission to evolve closed contracts in place.

Old readers reject the new value; there is no downgrade to `workspace_write`.
The cloud must refuse autonomous launch without the exact new capability, and
the local planner independently requires it. Schema, generated validators,
cross-language positive/negative fixtures and upgraded private-pilot components
ship together. Existing manual snapshots and historical evidence are preserved.
No production rollout or compatibility claim for older installed clients is
made by this exception. Other wire changes still require a negotiated version.

## Decision: separate run authority from lifetime completeness

- Keep strict single-group supervision as the default. Add a locally compiled,
  exact-provider-candidate root-supervision mode selected before spawn and
  durably bound to a new execution. Never reinterpret an existing unknown
  execution or clear its historical flags to enable this mode.
- Root authority requires the current signed supervisor, held authenticated
  worktree lock, original live provider PID/start/PGID and unchanged assignment.
  Local MCP still authenticates the kernel peer and its live ancestry/root
  group independently, and applies every current cloud/session/result fence.
- A same-UID descendant first observed through verified live ancestry may be
  recorded in its own group without treating that fact alone as an authority
  failure. It is lifetime evidence, not permission to signal another group.
  PID replacement, changed recorded group, malformed or incomplete history,
  ambiguous ancestry and observation overflow still fail closed.
- The retained direct provider child reserves only the original root PGID.
  Remote interrupt/terminate may target only that group. Never send `killpg`
  to a provider-reaped descendant group's remembered numeric ID, and never
  describe root-group signal delivery as proof that the whole family stopped.
- Detached-compatible mode declares whole-family coverage unproven from
  spawn, not only after observing an escape. Root exit revokes run authority
  and does not automatically release checkout occupancy. Retain the durable
  lock/recovery marker through helper or daemon restart and close all prior
  MCP capabilities. No inferred result or accepted completion is added.
- Explicit local operator recovery is distinct from automatic proven cleanup.
  Releasing this mode requires the original root and every retained live
  identity to be absent, the exact lock/assignment binding, and a deliberate
  acknowledgement that polling cannot rule out unobserved background work.
  It must be recorded and described as operator-authorized recovery, not
  kernel-proven whole-family absence. Cloud or agent MCP cannot issue that
  acknowledgement. Until that separate acknowledgement path is implemented
  and verified, recovery for this mode remains denied.

This is managed-run coordination on a trusted user's Mac, not hostile-process
containment. The revised mode intentionally trades automatic checkout release
for compatibility without making a false complete-family cleanup claim.

### Root-lease observations

Use a separately closed `checkout-root-lease-observation` document with
`schema_version: 2` at the fixed runner route `leases/observe-root`. Keep the
original lease-observation document and its `contained` semantics unchanged.
The new document carries the same bounded assignment, fencing, supervisor,
lock, root-group identity, sequence and observation-time fields, together with
`supervision_mode: root`, `family_coverage: unproven` and
`descendants_state: unproven`. Initially its only operations are `renew` and
`unknown`; it cannot release a lease or represent operator acknowledgement.
An older server rejects this route/document; the runner must never downgrade
it to a v1 contained observation.

The first authenticated observation pins root scope into the existing durable
lease identity. A root observation cannot upgrade an already strict or unknown
lease, substitute another identity, erase uncertainty, or release occupancy on
expiry. Renewal requires independently verified live root authority. Root loss
records uncertainty and cannot produce a normal process-exit assertion. The
cloud transport remains runner-authenticated and all existing assignment,
requester, grant, policy, result, freshness and fencing checks still apply.

## Required proof and rollout

1. Permission fixtures prove explicit opt-in, unchanged manual behavior,
   disallowed combinations, capability denial, snapshot immutability, exact
   resume, old-reader rejection, and no production-manifest promotion.
2. Native synthetic fixtures prove detached-hook startup, authenticated MCP
   access, unrelated-peer denial, root-only signals with surviving detached
   children, root-exit revocation, PID/group replacement, overflow, restart
   retention and denied automatic release/recovery.
3. Operator recovery must have separate acknowledgement, negative authority
   tests and truthful audit/state evidence before it becomes usable.
4. Run affected protocol/domain/native gates, `pnpm verify` and `pnpm test:l07`.
   Preserve failed attempts and bounded, redacted evidence.
5. Only then build a new isolated signed candidate and exercise a fresh
   authorized live run. Do not mutate or revive the current closed execution,
   change unrelated Claude settings, or treat synthetic proof as live proof.

The reduced automatic-cleanup guarantee must remain visible in pilot guidance
and status. It does not certify full L05-equivalent family cleanup, mark L07
done, implement Codex, or authorize production deployment.

## References

- [Claude command-hook process contract](https://code.claude.com/docs/en/hooks#hook-input-and-output)
- [Claude permission flags](https://code.claude.com/docs/en/cli-reference)
- [Darwin kqueue flags](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/event.h)
- [Local MCP authority](0004-local-mcp-runtime-authority.md)

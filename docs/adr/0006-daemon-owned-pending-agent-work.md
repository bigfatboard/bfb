# ADR 0006 — Daemon-owned pending agent work and truthful recovery

Status: Accepted for implementation under the already approved local-MVP
scope in [mvp.plan.md](../../mvp.plan.md), 5 October 2026, following independent
design review. This is not new personal approval, permission to enable a
workspace's offline policy, or evidence that replay works. Online session
binding and writes remain governed by
[ADR 0005](0005-agent-work-session-and-attribution.md).

## Context

The current production path denies offline writes. The legacy injected-host
journal is not production acceptance: it keys operations by an unscoped
request ID, hashes only part of their authority, does not exclusively claim
replay rows and ignores acknowledgement persistence failures. A hash that a
same-user process can recompute is not a protected daemon capture proof.

The host currently performs live authorization before its offline branch.
Changing `AllowPending` cannot fix that ordering or move ownership into the
daemon. A pending operation must survive MCP exit without giving the provider
a runner credential or generic authenticated proxy.

A lost response does not prove a failed mutation. If the cloud commits and
authority is revoked before retry, authorization-before-cache correctly denies
the original result. Recovery must retain that uncertainty, not report that
the effect never happened or bypass authorization to recover its private body.

## Decision

### Explicit policy pinned by immutable versions

Add one closed `offline_agent_work` setting to the existing workspace, project
and repository policy model:

```json
{
  "allowed_tools": [],
  "max_pending_age_seconds": 0
}
```

The default is deny. The only selectable tools are A01's task update, comment,
progress and proposal writes. Attention, result submission, artifacts, launch,
policy and administration are not admitted by this decision. A nonempty set
requires an integer age from 1 through 300 seconds; an empty set requires zero.
Project/repository policy can only remove tools or shorten the parent limit.
The daemon atomically admits at most 256 unresolved operations per run,
including claimed and unknown outcomes, not just waiting rows.
Also cap unresolved operations across the daemon at 1024 and retained journal
rows at 10,000, with per-row encoded bounds. These are explicit admission
limits, not an automatic retention/deletion policy. At capacity, identical
identities still receive authorization/fingerprint checks; unseen identities
fail before dispatch. Never erase unknown outcomes to make room. Claims are
bounded batches of at most 16 with a 30-second claim deadline and bounded
network requests; they do not hold a SQLite transaction over network I/O.

Use the existing owner/project-grant, optimistic-version and sensitive-action
policy update path. Require the complete new setting on an update; omission
never grants permission. Bind the user-verifying proof target to a versioned
policy-update domain, action, workspace/project, expected version, normalized
existing fields and the sorted tool set/age. A proof for the old target cannot
authorize the new fields. Validate and consume a new mutation's proof in the
serialized Hub unit, with all preflight reads before staged writes. A cached
outcome still needs current authority but does not consume the proof twice.
Use read-only current actor/project authorization before the idempotency
lookup. For a new effect, validate the proof/target and complete all policy
preflight reads, then stage conditional proof consumption, guarded policy-head
update, immutable version and idempotent outcome in one batch. Abort the whole
batch on a losing guard. The existing nested-transaction/post-read step-up
helper cannot be called unchanged inside this staged command. The business
fingerprint covers normalized settings and expected version, not the one-use
proof identifier.

Repository configuration reporting currently has owner/project authorization
but no step-up. Require the new versioned, action-bound proof whenever its
submitted canonical document explicitly contains `offline_agent_work`, even
when that setting denies capture. Bind the target to action, workspace,
project, expected repository version, canonical document hash and normalized
offline setting. A report omitting the field retains the existing authorized
reporting path but produces empty/zero permission, never inheritance. Thus no
enabled repository version is created without proof. Validate and consume
that proof inside the same serialized batch, not in the HTTP adapter.

Keep existing launch-snapshot v1 bytes and hashes unchanged. The source of
capture permission is the three exact immutable policy-version rows already
referenced by that snapshot, not current heads or a mutable profile. Additive
database columns give every historical row explicit empty/zero permission;
only new policy versions can enable capture. No permission is reconstructed
for older rows. Launch reauthorization continues requiring exact current
version equality, so even a more permissive policy edit invalidates the old
launch instead of widening it in place. Test unchanged historical hashes.
Historical repository canonical JSON and content hashes stay unchanged too.
An omitted repository setting resolves to empty/zero permission, not the
parent's enabled offline setting. Keep an existing `{}` document's canonical
bytes/hash unchanged. Project defaults and synthetic seeds also start denied;
only an explicit new setting can produce enabled columns in a new version.
The legacy launch policy projection remains unchanged: L05 must not interpret
the absence of this new field in a frozen v1 snapshot as a new repository
ceiling. Capture confirmation/replay reads the exact immutable policy rows
separately. Require the snapshot's repository hash to match its referenced
repository-version row. Existing local launch tightening can change that hash
without changing the version reference; such a launch cannot borrow the old
row's offline permission. It remains online-only until a matching approved
version/new launch exists. Do not widen the closed launch-tightening document.

### Short-lived daemon capture confirmation

A new closed, versioned bound-authority response confirms the canonical
session, assignment, launch snapshot hash/generation and policy references,
requester/runner grant and authorization epochs, key thumbprint, checkout
fence/lease expiry and credential expiry. The daemon obtains and caches it
only after current cloud authorization and fresh local containment/session
checks. The provider cannot select these fields or renew this confirmation.

New capture ends at the earliest of the last confirmed lease expiry,
credential expiry and 45 seconds after confirmation. This deliberately may
allow only seconds of capture during an outage. Queue retention is separate
and uses `intent_expires_at = captured_at + effective_policy_age`. Its deadline
does not reuse the old lease or credential expiry. Use a conservative elapsed
deadline anchored to request send time; derive persisted capture time from
confirmed server time plus elapsed time since response receipt, not send time.
Each refresh uses a fresh daemon-owned confirmation request identity, separate
from the stable business operation identity. Retrying that same confirmation
keeps its original server confirmation time and original send/deadline anchor;
a delayed cached reply cannot restart a 45-second capture window. If the
original timing anchor is unavailable, obtain a new live confirmation instead
of inventing one from receipt time. Daemon restart follows the same rule.
Worker verification checks the capture-time inequalities and maximum age.
Wall-clock rollback cannot extend permission. Use suspend-inclusive elapsed
time or invalidate cached permission on sleep/wake before further admission;
ordinary Go monotonic time alone is not a sleep boundary.
Daemon restart discards permission to capture new intents until fresh online
confirmation; previously signed intents remain available for disposition.

Use one complete confirmation shape for both admission modes. It retains the
effective configured policy and both actual repository hashes. A tightened
snapshot whose repository hash differs from the referenced immutable row can
still record online provenance, but cannot admit offline work. Configured
permission is separate from the signed intent's admitted permission:
`online_only` always admits empty/zero and has `intent_expires_at: null`,
which grants no replay horizon; `offline_admitted` records the checked
effective permission and an exact capture-time-plus-policy-age expiry.
Ordinary online writes therefore obtain complete confirmation provenance too;
they do not fabricate missing policy, epoch or time fields.

During that bounded interval, the daemon still verifies the live kernel caller,
execution containment, immutable assignment and exact trusted session, and
rejects any known authority denial. It cannot prove remote grants remain
unchanged while disconnected; revocation is rechecked on contact and before
replay. No immediate-offline-revocation guarantee is claimed.

Capture is implemented inside fixed daemon write admission, not by making
`AuthoritySource` falsely report current online authority or treating every
transport error as permission. Host validation and sticky terminal capability
closure remain. Reads and delivery of cached successful outcomes still require
current authorization; a pending receipt is not memoized as a committed result.
No first-time session activation is invented during an outage. Unsupported
operations or unavailable proof fail visibly, without `pending_sync`.

### Protected complete capture

Reuse the existing daemon-only enrolled P-256 signer with a distinct fixed
`BFB-AGENT-WORK-CAPTURE-V1` domain prefix. The daemon derives both credential
reference and closed transcript after admission; no signing, digest, key-ref
or arbitrary-transcript RPC is exposed. Sign the exact normalized payload
hash plus bounded metadata, not another copy of the private body. Reject a
transcript exceeding the signer's 8192-byte limit.

The signed transcript includes the stable operation key, original request ID,
tool/reference schema, exact payload hash and expected version; workspace,
project, source task and any supplied target/parent; run/execution/generation,
runner/checkout/fence; requester and grant/epoch identities; canonical and
observed session/provider; snapshot hash/generation and all policy versions;
exact capture permission, confirmation/capture/expiry times and key thumbprint.
It cannot invent a proposal's future generated task ID.

Canonicalize the exact original typed business request, including its binding,
omissions and original whitespace, before hashing. This preserves ADR 0005's
existing fingerprint, which precedes C08's body trimming. Do not insert a
default priority or replace absent progress fields with null for this hash.
The business fingerprint remains bare lowercase SHA-256 hex; the capture's
payload digest uses the existing `sha256:` prefix over those same bytes. Keep
both separate from the capture signature. Sign the UTF-8 domain prefix, a
newline, canonical closed unsigned metadata and a final newline; the existing
signer hashes internally. Encode its 64-byte P1363 signature as canonical
unpadded base64url, checking decoded size and exact re-encoding.

Verification uses the original assignment/enrollment key identity, not an
arbitrary JWK stored in the row. The Worker verifies the signed capture on
replay and independently derives current scope/authority. Credential renewal
does not alter operation identity; revocation or key/grant replacement does
not renew a capture. The runner key remains local and never enters MCP or a
provider environment. Signing attests capture, not cloud application, current
permission, encryption or resistance to file deletion/rollback. The existing
software Keychain key is not represented as a Secure Enclave non-exportable key.

Captured token epoch/expiry are historical admission provenance, not values
that a renewed token must still equal: ordinary token issuance increments its
epoch. Replay authenticates a current valid token while preserving exact
requester/owner and runner authorization/grant epochs, assignment/session and
key thumbprint. A replacement key cannot re-sign an old intent. Name the
original operation schema separately from the replay-envelope version; only
the former participates in the existing operation key.

### One identity, separate delivery and effect certainty

Use ADR 0005's scoped operation key and business-input fingerprint unchanged
for online dispatch, uncertain retry and authorized replay. Capture metadata
is separately verified; it must not change that fingerprint. Never generate a
replacement request ID, rebase a version or retry under a new run/session to
hide a conflict or recover an uncertain effect.

Persist the immutable intent and a monotonic `dispatch_started_at` marker
before any business-write network send, including an ordinary online write.
This reconciliation bookkeeping does not grant autonomous retry or offline
capture permission. A marker-storage failure prevents dispatch. A crash
between marker and send may conservatively produce uncertainty.
Persist a signed immutable admission mode: `online_only` or
`offline_admitted`. Ordinary authorized online writes still record their
intent/dispatch with empty offline policy; only explicitly admitted offline
intents enter autonomous replay. A later policy change, cached marker or
request failure never upgrades an online-only record.

| Durable fact | Truthful disposition |
| --- | --- |
| Captured with explicit permission, never sent | Pending local intent; not cloud acceptance |
| Dispatch started but no durably confirmed response | Possibly applied; outcome unknown |
| Validated cloud success durably acknowledged | Applied internally; delivery still requires current authority |
| Explicit terminal denial before any dispatch | Rejected with no effect from this intent |
| Authority, policy, session or expiry blocks a possibly sent intent | Delivery blocked, effect unknown; never “no effect” |

A returned response alone is insufficient for a durable acknowledgement.
Failure to persist success or a terminal disposition returns a storage failure
and retains recoverable uncertainty. Expiry does not erase an unknown outcome.
If a prior success is already durably known, later revocation does not rewrite
that internal fact, but still prevents returning its private cached outcome.
Do not add a privileged result-lookup bypass.

The capture signature protects immutable intent, not later claims, dispatch
markers or acknowledgements. Their ordering, exclusive ownership and quota
properties are crash/concurrency guarantees over untampered daemon storage,
not cryptographic history or anti-rollback guarantees. Missing or corrupt
history is unknown/quarantined, never reconstructed as never-sent from a valid
capture signature alone. Do not use unauthenticated row-supplied public keys
or statuses as canonical cloud evidence.

### Serialized daemon recovery

Start one bounded replay service with the daemon. Transactionally claim rows
with a unique claim token, daemon incarnation and deadline; acknowledgements
must match that claim. Expired claims may be reclaimed with the original
identity/fingerprint. Check all claim/status writes and stop on local storage
failure. Do not turn a SELECT batch into purported exclusive ownership.

Replay verifies signature, complete capture, age and local assignment/session,
then obtains current runner/requester, session, policy and checkout authority.
Captured lease/credential expiry governs original admission; replay uses the
freshly verified current lease/credential, not equality with those old expiry
times. This first implementation deliberately stops autonomous delivery at
intent expiry, even if a previously committed cached outcome might exist.
That fail-closed choice may leave permanent unknowns consuming quota; do not
promise eventual recovery or reroute expired intents through an online path.
All cloud checks precede cached outcomes. Expected resource version and child
admission apply only before a new business effect, not its own cached success.
Infrastructure failures remain retryable; explicit denial ends delivery using
the effect-certainty distinctions above. A replay caller need not be the exited
MCP process; its original capture was peer-verified and the owning execution
must still satisfy current supervision/authority.

The 45-second cloud lease is a freshness bound, not permission to replace
ownership. Existing L05 can renew the same unreleased execution/fence after
fresh native verification; replay waits for that ordinary renewal. Released,
replaced or containment-unknown ownership cannot be rescued. Never replay old
lease observations, fabricate current liveness or advance a generation here.

Use explicit new IPC/cloud documents for capture/replay admission and receipts.
Do not append optional fields to ADR 0005's closed local-agent v2 envelope or
to existing launch snapshots. Preserve the ordinary online operation route
and identity; the fixed replay path verifies its proof then invokes the same
domain preparation/effect logic, not parallel business rules.

### Closed transport contracts

Introduce separate closed `agent-capture-confirmation-request`,
`agent-capture-confirmation-result`, `agent-work-capture`,
`agent-work-replay-request` and `agent-work-receipt` documents, plus
`local-agent-work-rpc` with envelope version 3. Its only methods are the four
`mcp.v3.` writes, negotiated on the same checked socket through the existing
status advertisement. Keep bootstrap/session reads on v2 and do not widen its
schemas. Legacy v2 writes share internal write-ahead admission but cannot
return a pending receipt through their unchanged committed-result shapes.

Only the daemon calls fixed possession-authenticated `work/capture-confirmation`
and `work/replay` actions. No provider-facing confirmation, signing, replay or
journal-enumeration method is exposed. Confirmation requests contain only a
fresh daemon-generated identity, execution/generation and existing session
reference. The result contains the complete derived scope, checkout/fence,
requester and runner-owner identities/epochs, runner authorization/grant/token
epochs and key thumbprint, session, snapshot hash/generation, exact three
policy versions, both repository hashes, configured permission and confirmed
time/lease/credential expiries. Do not invent grant IDs where the existing
grant identity is a workspace/runner/project/requester tuple.

Use existing wire ULIDs for BFB human/record identities, not BetterAuth user
IDs. Existing digest encoding is `sha256:` plus 64 lowercase hexadecimal
characters, including the runner key thumbprint. Captured token epoch retains
its existing nonnegative range; authorization/grant epochs remain positive.
New capture timestamps use canonical UTC milliseconds without changing old
timestamp schemas. Bound complete encoded confirmation requests to 2,048
bytes, results to 4,096, original writes to 16,384, replay requests to 32,768,
signature transcripts to 8,192 and local envelopes to 65,536 bytes.

Replay preserves the original Hub business command name as well as its
operation key and fingerprint. Its capture-aware read-only authorization
wrapper runs inside the same serialized unit before the business cache lookup.
After current authority, compare the embedded confirmation against the
canonical result stored by its original confirmation command and independently
derive the current assignment/session/key and exact immutable policy rows.
Keep those reads before staged writes. Retain confirmation outcomes for at
least 345 seconds after confirmation: capture may occur up to 45 seconds later
and remain pending for 300 seconds. Existing idempotency storage has no expiry;
future retention work must preserve this minimum. Missing confirmation evidence
fails closed rather than reconstructing a new server-time anchor.

### Atomic journal migration and bounded evidence

Inspect journal version before modifying its schema. Upgrade transactionally
with scoped operation identities, immutable captures, claims and checked
acknowledgements. Legacy rows cannot acquire a signature or new authority.
Preserve terminal history without inventing provenance; quarantine legacy
pending rows as `legacy_capture_unverifiable`, with possible prior dispatch
unknown, never falsely never-sent. Legacy result submission remains unsupported
until its owning A03 integration. The journal stays user-only and bounded;
receipts/diagnostics contain no private body, credential or capture transcript.

## Required proof before enabling production capture

- Explicit deny, unbound session, unsupported tool, expired/invalidated
  confirmation, clock rollback/restart and known revocation never admit pending
  work. Sleep/wake cannot extend the original capture horizon. Online-only
  records never become autonomous replay permission.
- Exact-version policy tightening and step-up-target substitution negatives;
  historical policy/snapshot hash preservation and no permission backfill.
- Genuine L06 capture and canonical binding, then permitted outage capture,
  MCP exit, signed daemon restart and real Worker/Hub/D1 replay after ordinary
  same-owner lease renewal. No terminal UI or live provider inference substitutes
  for the actual typed runtime path.
- Real remote commit followed by lost reply and daemon restart: unchanged
  authority produces one effect; intervening revocation/session closure/expiry
  preserves possible application without a second send or leaked cached result.
- Never-sent denial is distinguishable from uncertain dispatch; failed marker
  persistence sends nothing, and failed acknowledgement never reports durable
  success/rejection. Concurrent/reclaimed claims keep one canonical effect.
- Payload, boundary, session, policy, time, key and signature tampering reject;
  same raw request ID in two runs cannot collide; changed content conflicts.
- Empty/current/legacy/interrupted journal upgrades preserve history and deny
  unverifiable captures. No helper silently re-enables old pending result tools.
- Complete exact A01, affected policy/lease/runner/kernel gates, repository
  verification and committed clean-checkout evidence. A01 and its dependent
  holds stay unchanged until full acceptance, not merely a passing unit replay.

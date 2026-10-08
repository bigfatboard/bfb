# WP-C15 — Scoped encrypted business secret vault

Status: `planned`

Risk: Very high

Test target: `pnpm test:c15`

Evidence manifest: `docs/work-packages/evidence/WP-C15/manifest.json`

## Outcome

Authorized humans manage and share workspace/project business secrets in the
approved BFB-managed encrypted vault, with explicit scope, revisions and grants.
Agent access is separately authorized and never implied by task or project access.

## Dependencies

- **Requires:** C11, W03.
- **Unlocks:** C14.
- **Can run with:** no concurrent shared auth, Hub, vault schema, key lifecycle or secret-delivery changes.

## Scope

- Define canonical encrypted records and scoped metadata separately from Worker
  infrastructure secrets, human/runner Keychain stores and provider credentials.
- Support explicit management, value access, grant/revoke, revision, rotation and
  recovery under a frozen role/project/credential matrix and step-up policy.
- Bind ciphertext to its workspace, project scope, record and revision; prevent
  substitution, accidental plaintext persistence and stale credential redemption.
- Provide a human-initiated value reveal and reference-only integration surface
  for approved consumers such as private catalog authentication.
- Define separately scoped agent grants and a value-delivery channel that does
  not put secrets into ordinary task context, telemetry or command-line arguments.
- Keep vault UI on demand; hide values by default without treating masking as ACL.

## Non-goals

Uploading local provider credentials, silently injecting secrets into prompts,
remote-shell/environment management, organization-wide implicit agent access,
end-to-end encryption claims, or provider launch changes in this product lane.

## Contracts

### Consumes

- Existing C03 fresh step-up and C04 workspace/project authority, transitively
  completed through C11; C01 WorkspaceHub/D1 command semantics.
- C11 current credential/task ceilings where an agent grant is task-bound;
  current operations redaction and W03 disclosure/theme conventions.

### Produces

- An owning ADR and versioned vault contract: key custody, authenticated
  encryption, bindings, recovery, rotation, step-up, grants and value delivery.
- Shared typed metadata/management commands and narrowly authorized redemption;
  sensitive results are excluded from ordinary cached receipts and activity.
- Reserved acceptance target and manifest path, not executable evidence yet.

## Work plan

1. Resolve key custody/recovery, encryption and rotation, manager/value-reader
   roles, step-up requirements and agent redemption in the ADR before `ready`.
2. Implement encrypted storage, reference commands and current-authority guards
   with empty/previous migration, tamper, retry and failure-boundary tests.
3. Add human reveal/management and bounded approved consumer integration without
   touching provider credentials or launching local work.
4. Certify rotation/recovery, revocation and seeded value-redaction scans through
   the owning clean target and full repository verification.

## Acceptance

- Authorized management/reveal is useful; cross-workspace/project, revoked,
  expired, stale and wrong-credential operations fail without disclosing values.
- Metadata access, project membership and task edit authority cannot substitute
  for a value grant. Agent grants specify recipient, consumer, scope and lifetime.
- Ciphertext/associated-scope substitution fails; committed storage, ordinary
  receipts, events/audit, diagnostics, artifacts and evidence contain no plaintext.
- Rotation and recovery preserve authorized access and exact revision lineage;
  retries produce one effect without retaining sensitive cached response bodies.
- A value delivered before revocation cannot be recalled; new reveal/redemption
  is denied. UI and documentation distinguish that limit from effective erasure.
- Browser reveal is explicit, bounded and hidden by default; both themes and
  keyboard/denial/draft behavior meet W03. No ordinary MCP context contains values.

## Evidence

Not run. Future evidence uses synthetic canaries, scope/rotation/recovery results
and redaction scans. Key material, ciphertext recovery exports with live secrets,
secret values and real task content are never committed.

## Risks and decisions

Timo approved the BFB-managed vault direction, not a cryptographic or recovery
implementation. Key custody, loss/rotation recovery, grants and the agent value
channel are unresolved before `ready`. Implementation must use current primary
platform/security documentation and the owning ADR, not a guessed key scheme.

## Handoff

Planned; no business vault or value delivery exists. Infrastructure/Keychain
credential support does not certify this capability or its future consumers.

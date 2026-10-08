# WP-C14 — Pinned workspace and project skill catalogs

Status: `planned`

Risk: Very high

Test target: `pnpm test:c14`

Evidence manifest: `docs/work-packages/evidence/WP-C14/manifest.json`

## Outcome

Humans inspect useful skills from a configured workspace Git repository and
project additions, then explicitly enable exact pinned versions for authorized
task context. Syncing or listing a skill never installs or executes its code.

## Dependencies

- **Requires:** C13, C15.
- **Unlocks:** none.
- **Can run with:** no concurrent shared catalog, knowledge, vault, authorization or context-schema changes.

## Scope

- Configure one workspace catalog and project additions with explicit management
  authority, supported Git source forms and bounded deterministic discovery.
- Resolve and retain immutable repository identity, exact commit, path and
  content hash; expose failed sync without silently substituting a moving branch.
- Qualify skill identity by source and resolve workspace/project name collisions
  explicitly. Listing and enablement are distinct operations.
- Deliver enabled pinned instruction content through C13's authorized composition
  with lineage; treat bundled scripts/assets as untrusted catalog content.
- Use approved C15 credential references for private source access, never local
  provider tokens, credentials embedded in URLs or values in context.
- Add on-demand project/workspace catalog controls in the existing Work Map UI.

## Non-goals

Automatic script execution, dependency installation, permission widening,
unreviewed branch tracking, local skill-file rewriting, provider integration or
a new package manager. Git source support is not silently restricted to GitHub.

## Contracts

### Consumes

- C13 immutable knowledge composition, project access and delivery lineage.
- C15 scoped source-credential references and redemption/redaction rules.
- Existing workspace/project administration and W03 disclosure/theme contracts.

### Produces

- A versioned source/discovery/enablement contract with exact pins, bounded
  fetch/discovery, collision policy, sync outcomes and authorization matrix.
- Typed catalog and enablement commands shared by web and authenticated MCP.
- Reserved owning target and manifest path; neither exists as acceptance yet.

## Work plan

1. Freeze supported Git transports/auth, size/file limits, safe fetch policy,
   skill format, collision rules and explicit enablement scope before `ready`.
2. Implement immutable catalog imports and current-authority Hub mutations;
   preserve the last successful pin separately from a failed update.
3. Add authorized inspection/enablement and context integration; verify revoked
   source credentials, stale edits, exact retry and source changes.
4. Certify useful public/private synthetic sources, web/MCP parity and both-theme
   browser discovery from a clean checkout with full verification.

## Acceptance

- A configured repository produces reproducible entries at an exact commit and
  content hash; changed bytes, unreachable sources and invalid skills fail visibly.
- Names alone cannot silently replace a workspace skill with a project addition.
  A task receives only explicitly enabled, currently authorized pinned versions.
- Duplicate sync/enablement causes one canonical effect; concurrent/stale updates
  and authority loss cannot return a cached forbidden catalog or composition.
- Cross-scope source/credential reads fail. Host redirects, repository paths,
  oversized archives and malformed content cannot bypass the frozen fetch limits.
- No sync, preview, enablement or context read runs a catalog script, writes local
  skills, starts a provider turn or widens a tool/secret grant.
- Credential values are absent from URLs, DTOs, task context, events and evidence.
  Both themes retain discoverable controls and at most two default item actions.

## Evidence

Not run. Future evidence records synthetic repository pins, hashes, collisions,
failure/authorization results and negative execution checks, not downloaded
private repositories, source credentials or real task contents.

## Risks and decisions

A Git catalog is an untrusted content source, not an authorization source. Before
`ready`, freeze import location/transport, private-source credential grants,
collision and enablement policy, and an ADR if a new trust boundary is introduced.

## Handoff

Planned; C13/C15 are not implemented. No skill sync, installation, enablement
wire or provider capability is claimed by current configuration snapshots.

# WP-C13 — Canonical project knowledge and instruction delivery

Status: `planned`

Risk: Very high

Test target: `pnpm test:c13`

Evidence manifest: `docs/work-packages/evidence/WP-C13/manifest.json`

## Outcome

Authorized humans maintain project instructions, documents and artifact references
in BFB. An authorized task-context read identifies the exact inherited versions
and hashes without rewriting local repository instructions or delivered history.

## Dependencies

- **Requires:** C11, W03.
- **Unlocks:** A05, C14, W04.
- **Can run with:** execution-lane work only after separate cloud/local delivery contracts are frozen; no concurrent shared schema, Hub or context-wire changes.

## Scope

- Version project-root instructions and documents as canonical BFB records with
  explicit project authority, audience, size limits and optimistic concurrency.
- Add project-owned artifact references without pretending current run-owned
  artifact records already support project ownership.
- Compose base checkpoint guidance, project instructions and task-specific
  context with explicit source/version/hash lineage and consumer audiences.
- Preserve immutable delivered compositions while rechecking current access on
  every new read and cached return. Later edits create versions, not history edits.
- Provide on-demand project Knowledge management and web/authenticated MCP
  parity through common domain commands; retain the W03 action budget.

## Non-goals

Local file synchronization, automatic import or replacement of `AGENTS.md` or
`CLAUDE.md`, provider prompt installation, remote start, peer-message delivery,
secret values, and publishing private task history into project knowledge.

## Contracts

### Consumes

- C07 project identity/access and immutable configuration; C08 task context and
  run snapshots, reached through C11's completed dependency chain.
- Existing task-only context deliveries and policy snapshots retain their meaning;
  new project-knowledge pins are explicit, not a reinterpretation of old records.
- C11 current task/root access and consumer-audience ceilings; existing V01–V03
  immutable artifact versions and isolated viewing; X03 scoped remote MCP.
- W03 progressive disclosure and the approved light/dark Work Map design.

### Produces

- An owning ADR and versioned project-knowledge/composition contract covering
  precedence, authority, bounds, availability and exact delivered lineage.
- Project knowledge commands/DTOs, immutable content and reference versions,
  and context composition that does not confer execution or secret authority.
- The declared acceptance target and bounded manifest. Their names are reserved;
  the command and manifest are not implemented by this planning package.

## Work plan

1. Freeze the role/audience matrix, project artifact ownership, precedence,
   multiline content bounds and snapshot lifecycle in the ADR and contract.
2. Implement canonical records and Hub commands with empty/previous migration,
   stale edit, exact retry and current-authority tests.
3. Add composed authorized context and on-demand project management; certify
   mounted API/MCP delivery and compiled browser behavior separately.
4. Run the owning target and full verification from a clean committed checkout.

## Acceptance

- Authorized project readers receive useful current knowledge; restricted,
  revoked, cross-workspace and narrower task/delegation reads do not disclose
  forbidden bodies, references, counts or cached compositions.
- Project knowledge never makes private task content project-visible. Any
  publication from private sources uses C12, not a knowledge-edit shortcut.
- Base/project/task sources are explicitly labelled and version-bound. Project
  text cannot override system instructions, authorization or local repository
  safety rules; conflicts/unavailable required knowledge are visible.
- Editing a source never changes a recorded delivery. An exact retry neither
  duplicates a version nor returns content after authority loss.
- Local instruction files remain byte-for-byte unchanged. The product-owned
  proof does not claim provider adoption or a live run from context retrieval.
- Both themes, keyboard discovery, drafts and denied/stale/loading/empty states
  pass the W03 action and accessibility checks.

## Evidence

Not run. The future manifest must separate domain/migration, mounted transport,
compiled browser and any independently owned local-provider proof. Retain only
synthetic content, version/hash lineage and bounded authority results.

## Risks and decisions

Task context currently has bounded single-line validation; it is not a project
Markdown store. Before `ready`, freeze the additive precedence and required-source
failure behavior, exact permission matrix, project artifact ownership and wire
limits. Changing instruction-delivery invariants requires the ADR first.

## Handoff

Planned; C11 is unfinished. No canonical project-knowledge implementation,
provider integration or acceptance certificate is supplied yet.

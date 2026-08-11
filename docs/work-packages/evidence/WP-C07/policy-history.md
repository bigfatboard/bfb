# WP-C07 policy and version history

Effective policy is an intersection: workspace ceiling, project policy, repository configuration, agent profile, runner capability, and an optional run override. Repository configuration and run overrides can remove permissions but cannot add a provider or capability denied by an earlier layer.

Workspace policies, project policies, repository configurations, and agent profiles use optimistic resource versions. Every committed change appends an immutable version row and semantic event; stale expected versions leave the current row, version history, event stream, audit stream, cursor, and idempotency record unchanged.

The public browser API requires one-time passkey step-up for policy changes and project-authority widening. Target digests use the canonical JSON tuple below before SHA-256 hashing:

- Workspace policy: action, null project, expected version, sorted providers, and the three capability booleans.
- Project policy: action, project ID, expected version, sorted providers, and the three capability booleans.
- Workspace-visible project creation: action plus name, slug, tint, normalized repository host, hosted repository ID, and repository subpath.
- Restricted-to-workspace visibility: action, project ID, expected version, and nullable changed name, slug, and tint.
- Project grant: action with the target human as the proof target and project boundary.

The proof must also match the authenticated human, retained authorization epoch, workspace, project when applicable, and empty delegated scopes. Consumption is conditional and one-time before the Hub mutation.

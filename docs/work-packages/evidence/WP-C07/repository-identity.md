# WP-C07 repository identity

Cloud identity is the tuple `(workspace_id, normalized_repository_host, hosted_repository_id, normalized_subpath)`. The host is lowercase, the hosted repository ID is opaque, and the subpath is a normalized relative path. The database enforces tuple uniqueness.

Accepted examples include `github.com`, an immutable GitHub repository ID, and `packages/control`. Root is stored as `.`. URL aliases, SSH forms, credentials, absolute paths, empty segments, parent traversal, and backslash traversal are rejected. Repository identity fields are immutable after project creation, so later display-name, tint, slug, or access changes cannot point the project at a different repository.

No project, event, API payload retained by the domain, or evidence artifact contains a local checkout path or provider credential.

# Dependency policy

Runtime toolchains and direct dependencies are pinned exactly. The pnpm lockfile, Go module files, Xcode version, GitHub Actions revisions, generated protocol code, and D1 migrations are committed.

Dependabot opens weekly npm, Go module, and GitHub Actions updates. Each update must state why it is needed, preserve the lockfile, pass `pnpm verify`, and run any package-specific compatibility fixtures. Major versions and security-sensitive auth, Cloudflare, MCP, database, process, or rendering libraries require an ADR or an existing work-package decision before adoption.

Security updates take priority, but checks are not weakened to accept them. Unsupported dependencies are replaced or removed in the owning package. Transitive overrides require a comment in `package.json` or `go.mod` naming the upstream issue and removal condition.

# BFB

BFB is a provider-neutral control plane where small teams coordinate coding agents, launch them in exact local checkouts, follow work live, route human attention, and review immutable evidence.

The repository is an AGPL-3.0 monorepo for the Cloudflare control plane, web application, Go runner and CLI, and native macOS shell. Work is delivered through independently verifiable work packages.

## Bootstrap

Install the versions in `.node-version`, `.go-version`, and `.xcode-version`, then run:

```sh
corepack enable && corepack install && pnpm install --frozen-lockfile
```

`pnpm verify` is the single repository gate. It checks formatting, lint, TypeScript builds and tests, source headers, documentation links, the generated work-package roadmap, Go formatting/vet/tests/build, dependency drift, and the Swift/Xcode targets on macOS.

The repository intentionally has no required `.env` file, machine-local path, or secret at this stage. On a Mac where `xcode-select` points to Command Line Tools, verification selects `/Applications/Xcode.app` for the command without changing the global developer directory.

## Commands

| Command | Check |
| --- | --- |
| `pnpm build` | Compile every TypeScript workspace target |
| `pnpm format:check` | Verify repository formatting |
| `pnpm lint` | Run static lint rules |
| `pnpm test` | Run repository unit tests |
| `pnpm headers:check` | Enforce two `ABOUTME:` header lines on source files |
| `pnpm docs:check` | Validate committed relative Markdown links |
| `pnpm roadmap:check` | Validate package metadata and generated roadmap output |
| `pnpm roadmap:write` | Regenerate only the marked roadmap blocks |
| `pnpm go:check` | Run Go format, vet, tests, build, and module-drift checks |
| `pnpm swift:check` | Build and test the unsigned macOS target |
| `pnpm verify` | Run the complete platform-appropriate gate |

## Repository map

- `apps/web`: browser application
- `apps/control-worker`: trusted-origin API, auth, MCP, and realtime Worker
- `apps/artifact-worker`: isolated artifact-origin Worker
- `apps/macos`: native macOS shell
- `cmd/bfb` and `internal`: Go CLI, daemon, and local execution packages
- `packages`: shared TypeScript domain, database, protocol, and UI packages
- `protocol`: versioned wire schema and fixtures
- `migrations/d1`: checked-in D1 migrations
- `tools/repository`: repository policy and verification tooling

- [Architecture](ARCHITECTURE.md)
- [Web/MCP-first architecture decision](docs/adr/0001-web-and-remote-mcp-first.md)
- [Work-package roadmap](docs/work-packages/README.md)
- [Acceptance matrix](docs/work-packages/ACCEPTANCE.md)
- [Grok web/MCP goal](docs/goals/GROK-WEB-MCP.md)
- [Contributing](CONTRIBUTING.md)
- [Dependency policy](DEPENDENCIES.md)
- [Security policy](SECURITY.md)

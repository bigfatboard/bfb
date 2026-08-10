# Contributing to BFB

BFB is built as a sequence of work packages. Start with the package roadmap, confirm every required package is `done`, and freeze the package's consumed and produced contracts before implementation.

## Local workflow

1. Install the exact versions in `.node-version`, `.go-version`, and `.xcode-version`.
2. Run `corepack enable && corepack install && pnpm install --frozen-lockfile`.
3. Run `pnpm verify` before changing code to establish the baseline.
4. Add an executable failure case before implementing observable behavior.
5. Run the package test target and `pnpm verify`.
6. Record bounded, redacted evidence at the package's declared manifest path.

Do not disable checks or commit generated output without its source and owning command. Do not commit `.env` files, credentials, provider transcripts, task bodies, private terminal logs, or machine-local paths.

## Initial ownership boundaries

| Path | First owning package |
| --- | --- |
| `protocol/schema`, `protocol/fixtures`, `packages/protocol-ts` | F02 wire contracts |
| `apps/web`, `apps/control-worker`, `apps/artifact-worker` | F03 Cloudflare substrate |
| `packages/db`, `migrations/d1` | F04 tenant persistence |
| `packages/domain` | C01 command kernel |
| `packages/ui` | W01 app shell |
| `cmd/bfb`, `internal/daemon` | L01 daemon kernel |
| `internal/checkout` | L02 checkout registry |
| `internal/providers` | L03 provider kit |
| `internal/auth` | C06/L08 runner authentication boundary |
| `apps/macos` | L04 macOS app |

F01 owns only the compile-safe targets, repository commands, and policy enforcement in these paths. Product behavior belongs to the listed package.

## Pull requests

Keep a pull request within one work package or one approved architecture decision. Include the exact verification command, result, evidence path, migrations or protocol versions changed, and real limitations. Formatting-only edits outside the package scope do not belong in the change.

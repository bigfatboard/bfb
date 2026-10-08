# WP-X02 command-to-owner matrix

Machine source: `internal/humancli.Table`, enforced by
`TestOwnerInventoryMatchesLiveRegistry`. Contract: `docs/contracts/human-cli.md`.

| Command | Owner | Gate proof |
| --- | --- | --- |
| `login`, `logout`, `whoami` | C05 | Device-flow route tests, harness issuance/parity run |
| `daemon run`, `daemon status`, `daemon stop`, `daemon logs`, `daemon install` | L01 | Assembled unchanged; `pnpm test:l01` owns behavior |
| `runner enroll`, `runner list`, `runner wake`, `runner forget` | L08 | Assembled unchanged; runner suites own behavior |
| `checkout link`, `checkout list`, `checkout verify`, `checkout unlink` | L02 | Assembled unchanged; checkout suites own behavior |
| `provider setup claude`, `provider doctor claude` | L07 | Assembled unchanged; adapter suites own behavior |
| `project list`, `project get` | C07 | CLI route tests plus harness parity rows |
| `task list`, `task get`, `task create` | C08 | CLI route tests plus harness parity rows |
| `run list`, `run get` | C08 | Column-identical browser/CLI reads, parity rows |
| `run submit` | A03 | Assembled unchanged; A03 suites own behavior |
| `run cancel` | C08 | Confirm plus fresh-proof gating, harness cancel rows |
| `attention list`, `attention get`, `attention answer`, `attention resolve` | A02 | CLI route tests plus harness parity rows |
| `hook ingest`, `hook status` | L06 | Assembled unchanged; journal suites own behavior |
| `mcp stdio` | A01 | Assembled unchanged; local-MCP suites own behavior |
| `artifact publish` | V01 | Assembled unchanged; artifact suites own behavior |
| `artifact list`, `artifact get` | V01 | Metadata-only reads, route tests plus harness rows |
| `execution recover` | L05 | Assembled unchanged; supervisor suites own behavior |
| `version`, `completion bash`, `completion zsh`, `completion fish` | X02 | Assembly-owned; version/offline and completion tests |

Golden outputs: `internal/humancli/testdata/goldens/` (`whoami.txt`,
`whoami.json`, `task-get.json`, `error-not-found.json`,
`cancel-handoff.txt`, `version.json`), compared byte-for-byte by
`TestGoldenHumanAndJSONOutputs` after request-ID normalization.

# X03 acceptance matrix

Each Acceptance bullet maps to automated tests. All fixtures are
synthetic; no provider executes, no secret leaves the test boundary,
and no owning-package (A02/A03/V01/X03A) behavior changes.

| Acceptance | Proving test |
| --- | --- |
| Every extension tool has parity tests against its domain command | `packages/domain/test/remote-parity.test.ts` twin-fixture comparisons: runner-shaped attention records, human-shaped submissions, human-shaped artifact versions, plus invalid-vector code parity; `apps/control-worker/test/mcp-remote-parity.test.ts` drives each tool through `handleMcpRequest` against the same commands |
| X03A authorization/revocation negatives preserved | `pnpm test:x03` runs the full X03A unit set (`mcp`, `oauth`, `mcp-handler`, `routes`, `d1-adapter` suites, 28 tests) unchanged, plus the OAuth browser flow |
| A client may request attention when delegated | Domain request test plus handler `runs the delegated attention loop`: open request, derived role, idempotent retry, committed read-back |
| A client may submit a result when delegated | Domain submit tests plus handler `submits a delegated result`: version 1, human attribution in D1, idempotent retry, task in review |
| A client may publish an artifact when delegated | Domain create/finalize tests plus handler `publishes and finalizes`: uploading version, grant secret returned once, verified receipt, available state |
| A delegated client cannot resolve, accept, approve, promote, or administer | `attack-matrix.md`: every denied path with its exact error code; unknown privileged tool names have no successful result |
| No persistent MCP session state | `proves no persistent MCP session state`: cross-delegation key isolation (`idempotency_authority_mismatch`), durable replay across isolated requests; every request builds a fresh server |
| No widened token scope | `requires the write scope` (read-only delegation reads but cannot mutate, including X03A tools) and `leaves delegation scopes and boundaries unchanged by tool use`; no new scopes exist in `oauth.ts` |

Negative cases also covered: malformed kinds/questions/references/evidence/git facts/digests with owning-package codes, unknown and foreign runs (`not_found`/`forbidden`), task-bound escape, run-less artifacts, terminal runs, missing execution context, missing upload receipts, revoked/expired/epoch-mismatched delegations (`forbidden`/`stale_authorization`), read-only scope (`insufficient_scope`), replayed artifact keys (`request_rejected`), and grant secrets absent from every D1 table.

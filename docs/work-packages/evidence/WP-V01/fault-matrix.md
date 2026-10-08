# WP-V01 fault matrix

Every row was proven failing-first against real Workers, D1, and disposable
R2 (`tools/artifacts/run.ts`, `V01_D1_OK`), mounted handlers
(`apps/artifact-worker/test/upload.test.ts`,
`apps/control-worker/test/artifact-routes.test.ts`), domain unit tests
(`packages/domain/test/artifacts.test.ts`), and Go race tests
(`internal/artifact`, `internal/cli`). No row yields an `available` version
except the two marked happy paths.

| Case | Proof | Result |
| --- | --- | --- |
| Happy path review publish (create → upload → finalize) | harness alternating isolates; R2 head confirms size + checksum | 201 / 200 / 200, `available` |
| Happy path log chunk (zstd, run key prefix) | harness with synthetic run | 200, key `runs/<run>/logs/<version>.jsonl.zst`, `available` |
| Grant replay (same grant twice) | harness + mounted worker | 403 uniform, one R2 put |
| Wrong secret | harness + mounted worker | 403 uniform, no effect |
| Unknown grant id | harness + mounted worker | 403 uniform |
| Missing Authorization | harness + mounted worker | 403 uniform |
| Expired grant (creation + 16 min) | harness advanced clock; domain unit | 403 uniform, version stays `uploading` |
| Revoked epoch between issue and use | harness double `bumpMemberEpoch`; domain unit | upload 403, finalize 403 |
| Reviewer create / finalize | harness + route test (uniform, no oracle) | 403 both |
| Foreign workspace finalize | harness nonexistent workspace path | 401/403/404, never 200 |
| CLI credential on browser routes | route test Bearer header | 401 `credential_confusion` |
| Finalize without receipt | route test + harness early finalize | 403 |
| Finalize wrong hash / size | domain unit + route test | 403 |
| Double finalize | domain unit + harness + route test | 403 |
| Re-grant on terminal version | domain unit + route test | 403 |
| Size mismatch (truncated bytes) | harness 422 + mounted worker | 422 `size_mismatch`, grant consumed, version recoverable |
| Digest mismatch (same size) | harness 422 + mounted worker | 422 `digest_mismatch` |
| MIME mismatch (PNG declared markdown) | harness 422 + mounted worker | 422 `mime_mismatch`, no R2 object |
| Log role with plain text | harness | 422, no R2 object |
| Oversized body (6 MiB) | harness 413 (grant consumed first) | 413 `body_too_large` |
| Oversized declaration at create | domain unit + worker test (6 MiB declared) | command rejected, no grant |
| Same-hash race (two versions, concurrent isolates) | harness `Promise.all` + R2 head | both 200, one object row, both `available`, bytes never overwritten |
| Conflicting object metadata under key | mounted worker pre-seeded object | 500, no receipt |
| D1 fault during consume | mounted worker throwing database | 403 uniform, no R2 write |
| R2 fault during put (no head) | mounted worker failing bucket | 500, version stays `uploading` |
| Upload budget across isolates (21st pinned IP) | harness alternating control isolates | 20 × 200 then 403; spared grant redeems from fresh IP |
| Grant-create budget (21st attempt) | route test loop | 20 × 201 then 403 |
| Abandoned sweep (expired grants + grace) | harness `sweepAbandonedArtifactUploads` + domain unit | only stale `uploading` → `failed`, `available` untouched |
| Explicit mark_failed + terminal re-mark | domain unit | `failed`, then 403 |
| Immutability triggers (version/grant/object/audit) | domain unit direct SQL | all illegal writes abort |
| Secret retention scan | harness D1 dump + route test idempotency dump | five grant secrets absent; bucket keys 64-hex; R2 keys workspace-prefixed |
| Go client error mapping | httptest doubles | 403/422/409/oversize/invalid map to typed codes; bodies carry no R2 key; secret never in URL |
| Local-RPC wire contract | `v01-publish` fixtures + daemon socket test | valid request/response accept; unknown field and missing path reject |
| MCP seam shape | `ToolDefinition` test | closed schema, required fields, 9-format enum; unknown tool args rejected |

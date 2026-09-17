# WP-V02 hostile corpus report

Every row was proven against real Workers, D1, and disposable R2
(`tools/artifact-viewer/run.ts`, `V02_D1_OK`). Browser sandbox and CSP
claims are proven separately by `apps/web/test/e2e/v02-viewer.spec.ts`.

| Case | Proof | Result |
| --- | --- | --- |
| Bootstrap served for unknown view ID | GET /view/:id returns byte-identical fixed document without bytes | 200, fixed bootstrap, no oracle |
| Redeem html | bounded POST with secret+nonce; exact version rechecked before bytes | 200 text/html; charset=utf-8, exact final CSP |
| Redeem svg | bounded POST with secret+nonce; exact version rechecked before bytes | 200 image/svg+xml, exact final CSP |
| Redeem markdown | bounded POST with secret+nonce; exact version rechecked before bytes | 200 text/html; charset=utf-8, exact final CSP |
| Redeem mermaid | bounded POST with secret+nonce; exact version rechecked before bytes | 200 text/html; charset=utf-8, exact final CSP |
| Redeem mermaid-huge | bounded POST with secret+nonce; exact version rechecked before bytes | 200 text/html; charset=utf-8, exact final CSP |
| Redeem json | bounded POST with secret+nonce; exact version rechecked before bytes | 200 text/html; charset=utf-8, exact final CSP |
| Redeem diff | bounded POST with secret+nonce; exact version rechecked before bytes | 200 text/html; charset=utf-8, exact final CSP |
| Redeem log | bounded POST with secret+nonce; exact version rechecked before bytes | 200 text/html; charset=utf-8, exact final CSP |
| Redeem png | bounded POST with secret+nonce; exact version rechecked before bytes | 200 image/png, exact final CSP |
| Grant replay | same view redeemed twice | 403 uniform, one byte effect |
| Wrong secret | valid view ID with unknown secret | 403 uniform, no effect |
| Wrong nonce | valid secret with foreign channel nonce | 403 uniform, no effect |
| Unknown view | random view ID with live secret | 403 uniform |
| Oversized body | 9 KiB redemption padding | 413 before bytes |
| Expired grant | redeem past 5-minute TTL | 403 before bytes |
| Revoked epoch | membership epoch bumped after issuance | 403 before bytes |
| Reviewer preview | reviewer role opens an available version | 200 |
| Uploading version | view grant for non-available version | 403 |
| Tampered R2 bytes | object overwritten after finalize; hash re-verified before serving | 500 view_failed, no grant leak |
| Redemption budget across isolates | 21 redeems from one pinned IP across alternating control isolates | 20 x 200 then 403; spared grant redeems from a fresh IP |

# V01 connected publication runtime acceptance

Tested source: `663dbdb9362cbc4f941bc052403f42b0bcd725e1`.
The runtime manifest and command result own command outcomes. Historical
`manifest.json`, `command-result.json` and `fault-matrix.md` remain unchanged;
their component scope is not silently extended.

## Proof boundaries

| Surface | Current proof | Boundary |
| --- | --- | --- |
| Contract | Separate closed `local-agent-artifact-rpc/6`, four schema-1 artifact documents, 1,123 protocol cases plus Go parity, deterministic generated output | The global wire stays `bfb-wire/1`; frozen v1–v5 fixtures and protected journals are not widened |
| Local input | Compiled MCP rejects absolute/traversal input; actual daemon rejects symlinks and hardlinks before cloud phases; secure-reader tests cover pinned root/intermediate/file replacement, permissions, regular-file and role/size limits | Filesystem replacement races are focused tests, not all native-harness scenarios |
| Publication | Actual compiled MCP and fresh bound CLI use trusted native assignment, L06 session binding, held flock, signed daemon and runner possession; real local Control Worker/Hub/D1 and separate Artifact Worker/R2 store exact verified bytes and provenance | Synthetic provider-shaped processes, not live provider turns or initial Terminal launch |
| Identity | Same request ID and bytes converge, including equivalent safe paths; changed bytes conflict without closing the connection; original omitted artifact ID remains omitted | No caller-selected scope, endpoint, credential, digest, key or version |
| Recovery | Lost prepare, upload and finalize replies recover the original operation/version after MCP exit and signed-daemon restart through explicit same-ID CLI/MCP retry | A bounded 4.2-second no-auto-send observation complements source/tests; no artifact journal, spool, new receipt family or automatic replay |
| Eligibility | Actual result submission permits publication while Submitted; authorized human acceptance then denies compiled MCP and fresh CLI; session/end/lease/grant faults recheck authority before cached/conflicting results; genuine lock release withholds a finalized private body | The connected TLS unit matrix separately proves daemon-known disconnect, revocation, removal, connection replacement and protected-epoch changes versus ordinary token renewal; it is not a live-WebSocket event proof |
| Storage | Real two-isolate harness proves one same-time grant winner/body read/R2 put, current authority, expiry/replay/content rejection, two-grant receipt convergence, conditional-null/checksum verification, same-hash convergence and durable IP budgets | Mounted/domain fault injection supplements real-storage checks; not every fault occurs in the native harness |
| Maintenance | Real storage harness covers fresh consumed-grant protection, fresh Hub abandonment decisions, concurrent/lost-reply/cache-loss audit convergence, late atomic rollback/retry and metadata-only projection | V01 dispatches only its bounded upload action set; viewer audit activation belongs to V02 |
| Downstream availability | Full repository verification includes existing viewer/review unit negatives for non-available versions | No V02 browser, V03 review or remote/human-CLI parity recertification |

## Observable results

The exact V01 target passes 1,123 protocol cases in ten files, 213 focused cases
in twelve files and nine Go race-tested packages. The real storage harness ends
`V01_D1_OK` with 37 named checks, four disposable R2 objects and 104 abuse
buckets. The signed compiled gate ends `V01_NATIVE_PROOF_COMPLETE` in
137.80 seconds; a missing or skipped native marker cannot pass the package gate.

D1 ends at `0043_agent_artifact_publications`, including additive exact
consumption identity in 0042 and immutable receipt/operation source binding in
0043. Historical rows receive no fabricated consumption identity. Daemon
migration `011_measurement_telemetry` and protected agent journal
`014_result_journal` are unchanged by V01.

The linked command result records full verification and affected A01–A04/L08
gates separately from the V01 gate. It retains resolved development and
certification failures, their scoped fixes and the final tested source.

## Limitations and redaction

- Only online bound-agent publication falls within this proof. An offline call visibly
  refuses; a later explicit same-ID call rereads and validates its file.
- The general historical artifact client is not X02 human CLI authentication;
  local native-run authority cannot replace human credentials.
- No Terminal automation, AppleScript, System Events, live Claude/Codex turn,
  deployed environment, cross-device pilot, complete running MVP or release
  acceptance was exercised.
- V02 viewer and V03 review integration, D02 production turn delivery, expanded
  privacy, project-root knowledge, skill catalogs, shared business secrets and
  the core light/dark redesign remain outside this certificate.
- Artifact bytes are intentionally stored in private R2. Redaction assertions
  concern ordinary receipts, audit/events, stored credentials and public
  results; they do not falsely assert that the artifact store contains no body.
- Retained evidence contains counts, markers and repository-relative references,
  not raw logs, secrets, private bodies, capability hashes or local paths.

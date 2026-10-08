# L01 local RPC evidence

Tested commit and environment: [manifest](manifest.json). All records below describe synthetic automated fixtures.

`pnpm test:l01` passed the shared protocol drift check, 136 TypeScript protocol cases, Go protocol checks and the local race-tested packages.

| Contract | Executed proof | Result |
| --- | --- | --- |
| Kernel peer identity | `TestDaemonLifecycleAndPeerIdentity` checks UID and PID from a real Unix connection | Passed |
| Unauthorized peer policy | `TestRPCFailureAndConcurrentClients` rejects a different UID and an invalid PID | Passed; simulated foreign identity, not another logged-in account |
| Private socket | Real socket mode is `0600`; unsafe paths and non-socket collisions are rejected without removing the target | Passed |
| Bounded canonical framing | `TestMalformedAndOversizedFramesAreClosed` rejects malformed JSON, duplicate keys, unsupported schema/direction, private payload and oversized frames | Passed |
| Correlation | `TestClientRejectsUncorrelatedReply` refuses a reply for another request | Passed |
| Extension registration | Duplicate/invalid registrations and invalid handler output fail; registered handlers remain callable concurrently | Passed |
| Native client | `TestSwiftUnixSocketClient` compiles the committed Swift fixture, connects to the daemon and validates the response against the canonical schema | Passed |
| CLI envelope | `TestBuiltinDispatchAndExitCodes`, `TestLeafRegistrationAndHelp`, `TestLeafCannotLeakUncontractedPayload` | Passed |

Success exits `0`; usage/schema `2`; denial `3`; unavailable `4`; internal/storage failure `5`; contention/conflict `6`. Reserved hook/MCP/launch entry points explicitly report `not_implemented`.

The four L01 wire fixtures are listed in the manifest. They are owned by `pnpm test:protocol`; generated schema consumers are owned by `pnpm protocol:generate`. Same-UID socket access is not execution authorization: A01 owns the additional process-ancestry and run-scope boundary.

# L02 policy, wire and local command evidence

The shared synthetic policy fixture contains five cases: empty inheritance,
sorted/deduplicated providers, deny-all restrictions, flag widening and provider
widening. Go parses YAML and the TypeScript test submits the equivalent document
through the existing WorkspaceHub commands. Canonical JSON, SHA-256 and inherited
effective settings agree; widening is rejected by both layers.

Negative parser cases include unknown/secret/path fields, wrong types, duplicate
keys, aliases, anchors, multiple YAML documents, excessive structure and size.
Real filesystem cases reject symlinked directories/files, a FIFO, a directory
used as a file and oversized data, while preserving the synthetic target file.

`TestConfigRefreshCannotAuthorizeOldOrWiderSpecification` first proves the
registered empty policy can be checked against its parent. A new restriction
changes the hash and makes verification stale. Refreshing it a second time does
not validate the old launch claim. The new hash works only with a compatible
parent; a syntactically valid widening still fails final execution validation.
L05 remains responsible for obtaining replacement/final authorization and locks.

## Sanitized commands and diagnostics

`TestCheckoutCLIAndRPCStaySanitized` starts a real private daemon, runs
link/list/verify/unlink through the actual CLI and Unix socket, validates every
output against the canonical protocol, removes the selected synthetic directory,
and proves the typed block appears both in the error and persisted list state.
Malformed/misplaced request fields fail without changing registration.
Responses and daemon logs are scanned for the fixture path, state path and remote
credential canary.

The committed checkout-summary fixture is a synthetic path-free snapshot.
Local paths are legal only in local link requests; response-path and unrelated-
request-path fixtures are rejected by both Go and TypeScript. These fixtures also
regress the generic constant-validation diagnostic mapping, which now agrees
between the two codecs. The complete protocol target passes 139 TypeScript tests
and its Go differential fixture suite.

No provider credential, local absolute path or configuration content is retained
in this report. Fixtures containing paths are explicitly synthetic inputs.

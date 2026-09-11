# L01 redaction evidence

The clean-checkout race-tested gate passed all redaction fixtures. Canary inputs are visibly synthetic in the committed tests; no personal content was used.

- `TestLogRedactionAndRotation` supplies bearer-token, absolute-path, task-body, hook-payload and environment-value canaries to every caller-controlled diagnostic field. All are rejected. Four rotated files remain within the configured test cap and contain none of the canaries.
- `TestLogReaderDropsUnknownAndUnsafeFields` seeds extra private fields and an invalid event on disk. Reads discard invalid entries and re-encode allowed fields only.
- `TestLogSymlinkIsNeverFollowed` and `TestLogReaderRejectsSymlinkedStateRoot` reject unsafe log objects without changing their targets.
- Handler panic, invalid response payload, migration failure and CLI leaf-output cases expose fixed typed errors rather than raw internal text.

Production diagnostics allow only event, fixed diagnostic code, generated request ID and timestamp. Rotation retains the current file and three archives, each at most 256 KiB; the CLI bounds reads to 200 entries.

Committed evidence contains assertion summaries and repository-relative fixture references. It contains no raw terminal log, real local absolute path, token, cookie, credential, provider transcript, environment value or private task/hook content.

# WP-C03 negative-test report

Tested commit: `ec75d9894b76312a894dd72cee7e56af5cc14f3b`

- A session cookie without fresh GitHub reauthentication cannot perform initial passkey enrollment.
- A session cookie without an existing user-verifying passkey proof cannot add or remove a later authenticator.
- Better Auth's ordinary passkey mutation routes are unreachable; only BFB-owned bounded routes remain.
- Missing or wrong Origin, cross-site Fetch Metadata, missing or wrong session-bound CSRF, oversized bodies, expired ceremonies, absent credentials, and invalid completion capabilities fail closed.
- A proof for one action cannot authorize a different action, target, human, client, resource, workspace, project, task, scope set, authorization epoch, or expiry.
- A successfully consumed proof cannot be replayed; concurrent consumption has one winner.
- A target-bound removal proof cannot remove a different passkey.
- Enrollment, challenge, assertion, removal, and unauthenticated attempts share durable D1 limits across two Worker isolates; the eleventh attempt is rejected and raw IP, route, assertion, and capability values are absent from bucket keys.

The real Chromium flow used two CTAP2 virtual authenticators with resident keys and user verification enabled. It registered the primary credential, rejected a wrong-action proof, consumed the exact proof once, rejected its replay, registered a second credential, removed only that target, and retained the primary credential.

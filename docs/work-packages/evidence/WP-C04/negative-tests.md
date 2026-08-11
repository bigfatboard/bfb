# WP-C04 negative-test report

Tested commit: `f0b94285597928dd8fed4251f24c269470c5a748`

- The first ordinary signer-in is not promoted. Bootstrap requires the external one-time secret plus fresh GitHub reauthentication bound to the exact human, authentication user, session, flow, and expiry.
- Bootstrap has one winner. Reusing either the flow or completion capability is rejected.
- Invitation acceptance rejects unverified, mismatched, revoked, expired, consumed, or wrong-secret attempts.
- Invitation creation for an active member is rejected. Removing a member revokes every pending invitation for that email, so an old capability cannot restore access.
- Member and reviewer principals cannot create invitations, change roles, or remove members. Cross-workspace targets are rejected.
- Ordinary routes reject owner demotion/removal. Direct database attempts cannot remove the final owner or the final user-verifying passkey of an owner.
- Membership and passkey identifiers cannot be changed or replaced through conflict clauses.
- Browser-only routes reject bearer credentials, hostile Origin or Fetch Metadata, missing or wrong session CSRF, oversized bodies, absent sessions, and organization shortcuts.
- Workspace selection in request JSON is ignored; route and principal authority determine the workspace.
- Raw invitation and bootstrap capabilities are not persisted, audited, logged, or used as abuse-bucket keys.
- Seven unauthenticated surfaces share durable D1 attempt budgets across two Worker isolates; the eleventh attempt is rejected.

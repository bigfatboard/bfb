# WP-C04 migration constraints

Tested commit: `f0b94285597928dd8fed4251f24c269470c5a748`

Migration `0010_workspace_authorization` adds:

- retained authorization epochs that survive membership removal;
- one winning first-owner bootstrap claim;
- hashed, expiring, single-use invitation capabilities;
- immutable membership and passkey identities;
- insert-collision guards that reject `INSERT OR REPLACE` identity replacement;
- final-owner delete/demotion guards; and
- final-owner final-user-verifying-authenticator deletion/replacement guards.

The migration backfills retained epochs for existing members. Foreign keys preserve workspace, human, authentication-user, session, and passkey identity relationships. Database tests exercise direct SQL attempts so application-route checks are not the only enforcement layer.

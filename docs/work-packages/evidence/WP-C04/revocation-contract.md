# WP-C04 revocation contract

Tested commit: `f0b94285597928dd8fed4251f24c269470c5a748`

Removing a non-owner member is one workspace command. It:

1. revokes pending invitations for the member's normalized verified email;
2. removes project grants;
3. revokes active OAuth delegations;
4. increments and revokes the retained workspace authorization epoch;
5. removes the active membership; and
6. records the audit, event, outbox, and workspace cursor effects atomically.

Principal loading joins active membership to the retained epoch and fails closed on a missing, mismatched, or revoked epoch. Existing credentials therefore stop authorizing the next command before asynchronous credential cleanup. Re-invitation advances the retained epoch again; it never resets the epoch to its initial value.

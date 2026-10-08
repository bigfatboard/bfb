# Step-up trace (W02 browser E2E)

- Runner: Synthetic Launch Mac (`01JBFB0TASKW021000000000R1`)
- Sharing change without proof: 403 (fresh assertion required).
- Reviewer sees no sharing form and their change is 403.
- Stale-epoch proof after removal: 403 (each change consumes its own assertion).
- Mismatched-action proof (`runner.revoke` for grants): 403.
- Removal then re-add of the member launcher succeeded through the UI with fresh assertions.
- Result: adding/removing a named launcher requires a fresh action-bound passkey assertion.

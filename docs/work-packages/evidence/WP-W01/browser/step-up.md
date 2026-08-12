# Step-up trace (W01 browser E2E)

- Surface: owner Projects & policy
- Mutation: workspace policy version 1, run overrides true to false
- Browser: Chromium virtual CTAP2 platform authenticator
- User verification: required
- Action: `workspace.policy.update`
- Target: SHA-256 of the exact expected version and submitted settings
- Result: one-time proof consumed by the policy mutation; version advanced.

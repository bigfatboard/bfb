# Step-up trace (W01 browser E2E)

## Browser path

1. Sign in as `owner@synthetic.test` with synthetic password.
2. Navigate browser to `/oauth/authorize` with PKCE + workspace but **without** `step_up_proof_id`.
3. HTTP status: 400
4. Response body excerpt: {"error":"invalid_request","message":"workspace_id and step_up_proof_id required"}

## API proof path (documented)

Sensitive OAuth delegation requires an action-bound C03 step-up proof:

1. Issue proof via domain `issueStepUpProof` for action `oauth.delegation.create`.
2. Pass `step_up_proof_id` on `/oauth/authorize`.
3. Exchange code at `/oauth/token`; proof is consumed when minting the delegation.
4. Ordinary authenticated session alone cannot complete privilege/delegation changes.

Result: browser authorize without step-up proof fails closed with invalid_request.

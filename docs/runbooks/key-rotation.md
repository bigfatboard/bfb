# Key and secret rotation runbook

Coordinate system: the secret inventory and the current/previous `kid`
overlap rule are frozen in [../contracts/release.md](../contracts/release.md).
Rotation is an incident-class operation: two keys are live during overlap,
one key is live after.

## Overlap procedure (every Worker secret)

1. Mint the replacement value. For `kid`-carrying verifiers, assign the new
   value the next key id and keep the old value under the previous id.
2. Set both values (`wrangler secret put` for the current and previous
   entries, or the provider-native equivalent for GitHub and VAPID keys).
3. Deploy. New signatures mint under the current id; verifiers accept
   current and previous.
4. Watch delivery, queue, and auth error rates for one full Cron and retry
   cycle. The operations health rotation signal flags runner tokens
   expiring within 24h (`TOKEN_ROTATION_WARN_MS`).
5. Remove the retired value and deploy again. Verification under the
   retired id must now fail; `pnpm test:g02` drills exactly this state
   machine on synthetic keys.

## Per-secret notes

- `BETTER_AUTH_SECRETS`: overlap keeps existing sessions valid; skipping
  overlap logs every human out.
- `AUTH_ABUSE_SECRET` and `UPLOAD_ABUSE_SECRET`: overlap re-keys abuse
  budgets without locking out legitimate clients.
- `GITHUB_WEBHOOK_SECRET`: rotate the GitHub app secret first, then the
  Worker secret, so deliveries verify throughout.
- `GITHUB_APP_PRIVATE_KEY`: install the new GitHub key before retiring the
  old one; the reconciler converges in-flight outbox rows.
- `VAPID_PRIVATE_KEY`: ship the new public/private pair together; push
  endpoints bound to the old pair fail closed until resubscribed.
- Runner P-256 keys: re-enroll the runner per workspace. Revocation fences
  the old key before cleanup; the old private key is deleted from its
  Keychain item on forget.
- CLI `bfb_cli_` credentials: revoke the binding (authority dies in the
  same command), then approve a fresh device flow. Hash-only storage means
  there is nothing to re-encrypt.
- Provider credentials: provider setup and doctor per L03/L07/P01/P02;
  never paste a provider credential into a Worker secret or a chat log.

## Incident rotation

On suspected compromise: revoke first (binding revoke, runner revoke,
GitHub key delete), then rotate with zero overlap lifetime, then audit
`security-audit` for the exposure window. Record the incident id in the
handoff notes.

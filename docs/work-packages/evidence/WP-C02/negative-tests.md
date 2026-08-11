# WP-C02 negative-test report

Tested commit: `d001ca2ffa4e46a3e8311528307d2679134e919d`

- Missing or wrong Origin, cross-site Fetch Metadata, and missing, wrong, or cross-session CSRF tokens reject browser mutations.
- Alias cookies, malformed cookie encoding, expired sessions, and session cookies presented to MCP, OAuth token, runner, webhook, or artifact routes do not authenticate those surfaces.
- Email/password, account linking, token refresh, user mutation, user deletion, and session-management paths outside the bounded C02 surface remain disabled.
- A GitHub identity colliding by email is not linked implicitly, and a valid new identity has no workspace membership.
- Provider access, refresh, and ID tokens are encrypted before persistence; current and previous key IDs decrypt their own retained ciphertext without exposing plaintext.
- Public sign-in and invalid callback attempts share durable D1 limits across two Worker isolates, return bounded failures, reject oversized bodies, and store neither raw IP nor OAuth code/state material in bucket keys.

The focused suite passed 22 tests, and the Workerd smoke confirmed ten allowed attempts followed by one rejection for both sign-in and invalid callback paths.

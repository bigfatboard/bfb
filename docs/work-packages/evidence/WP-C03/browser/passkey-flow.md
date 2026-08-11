# C03 browser WebAuthn trace

Tested commit: `ec75d9894b76312a894dd72cee7e56af5cc14f3b`

- Chromium used a CTAP2 platform authenticator with resident keys and user verification enabled.
- A BFB-owned initial-enrollment flow registered the primary credential.
- A proof for `oauth.delegation.create` could not authorize additional enrollment.
- A user-verified `passkey.enroll.additional` proof authorized one additional credential and failed on replay.
- A target-bound `passkey.remove` proof removed only the selected additional credential.
- One primary credential remained.

The screenshot was retained through the explicit evidence-capture mode after the same browser test passed in the clean-checkout package gate. It contains synthetic identifiers only.

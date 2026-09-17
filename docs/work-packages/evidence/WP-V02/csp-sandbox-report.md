# WP-V02 CSP and sandbox browser report

Real Chromium drove hostile previews inside the intended sandboxed iframe and as
directly opened top-level redeemed documents. Every row below was observed in
this run; the self-report channel carries test data only and never authority.

| Case | Observation |
| --- | --- |
| Iframe hostile HTML | cookie empty, referrer empty, URL carries no secret, control API blocked, beacons blocked, popup null, top navigation contained, storage blocked, parent DOM blocked, form still here, no download, zero app hits |
| Iframe hostile SVG | cookie empty, API and beacons blocked, popup null, navigation contained, zero app hits |
| Iframe image and markdown | both redemptions succeed, zero app hits |
| Iframe wrong nonce | bootstrap submits, server rejects before bytes |
| Iframe message without port | bootstrap ignores it, no redemption attempted |
| Iframe double message | single redemption, second channel message ignored |
| Top-level hostile HTML | cookie empty, referrer empty, network/forms/popups/downloads send nothing, self-navigation carries no credential or secret, page keeps no attacker footing |
| Top-level hostile SVG | cookie empty, network/forms/popups send nothing, self-navigation carries no credential or secret |
| Top-level markdown | no script elements, hostile markup visible only as escaped text |
| Top-level mermaid | active directives dropped without links, over-cap diagram falls back fast |
| Top-level image | image document loads, cookie empty, network blocked |

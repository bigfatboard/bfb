# WP-V03 hostile review evidence

Byte isolation for previews is owned and proven by V02 (`pnpm test:v02`):
the fixed bootstrap, single-use grants, redemption sandbox CSP, strict text
renderers, and the 11-scenario Chromium corpus. V03 reuses the identical
`ArtifactViewer` component and frame wiring without modification.

What V03 proves on top, in `apps/web/test/e2e/v03-review.spec.ts` with
screenshots in `browser/`:

- A hostile review note (`</script>`, cookie-theft script, `onerror` image)
  submits end to end, stores verbatim, and renders only as inert text: the
  note's literal `<script>` text is visible while zero `script` elements and
  zero `[onerror]` elements exist in the page.
- The review surface mounts the preview frame with exactly
  `sandbox="allow-scripts allow-forms"` and `referrerpolicy="no-referrer"`
  with a `view/` source on the artifact origin; switching versions remounts
  the viewer (`key={versionId}`) so a previous version's preview or armed
  state can never leak into the newly selected version.
- Serialized page HTML contains no artifact bytes and no review secret
  (reviews mint none; view secrets cross one `MessageChannel` port and are
  wiped, per V02).
- The audit payload for a recorded hostile review carries decision and
  identities only; the domain test asserts the payload contains no comment
  text.

What V03 does not claim: rendering untrusted bytes outside the V02 frame,
downloads from previews, or compressed log-chunk decompression (V02
non-goals, unchanged).

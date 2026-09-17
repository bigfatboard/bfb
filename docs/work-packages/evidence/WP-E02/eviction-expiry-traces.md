# Eviction and expiry traces (E02)

Workerd harness: `tools/realtime/run.ts` (two client Workers plus the real
`WorkspaceHub` DO and D1). It ends with `E02_REALTIME_OK` and this summary:

```json
{"readyHighWater":0,"committedHighWater":10,"invalidationsPerSubscriber":3,"reconnectRecovered":true,"expiredRejected":true,"revokedCloseFrame":"authorization_revoked","survivorInvalidations":1,"hostileKeptOutOfInvalidations":true,"hostileInReplayAsData":true}
```

- R1 handshake: `browser.realtime.ready` carries the D1 high-water with keys
  `schema_version, kind, workspace_id, connection_id, high_water_cursor,
  server_time`; attachments carry IDs/epochs/expiry only.
- R2 fan-out: one commit reaches every subscriber as `event.committed` with
  exactly `schema_version, kind, workspace_id, high_water_cursor`.
- R3 reconnect: a new connection recovers the same authority (same human and
  epoch, new connection id) and replays from the committed mark.
- R4 revocation: the revoked member receives `browser.realtime.close` with
  reason `authorization_revoked`; a later commit reaches only the survivor.
- R5 expiry: a past-dated session never subscribes (403, no socket).
- R6 hostile: `<script>` payloads never appear in invalidation bytes and
  replay as data through `listLedgerEvents`.

Exact close codes ride socket-double unit tests
(`apps/control-worker/test/browser-sockets.test.ts`): session expiry closes
4401 with `session_expired`; deleted sessions and membership epoch changes
close 4403 with `session_revoked` / `authorization_revoked`; only affected
sockets close. Workerd hibernation restore itself cannot be forced in the
harness, so eviction recovery is proven by attachment serialization across
manager instances; the miniflare test client does not surface
server-initiated close events, so the harness proves revocation teardown by
close frame plus attrition.

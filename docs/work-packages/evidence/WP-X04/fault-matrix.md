| Fault | Expected | Observed |
| --- | --- | --- |
| Invalid HMAC with unparsable body | 401 before parsing | F1 |
| Valid HMAC with invalid JSON | 400 parse failure | F1 |
| Unknown installation | 404, no rows | F1 |
| Non-Owner install/remap | 403 | F2/F4 |
| Write permission / unknown event | 409 inventory rejection | F2 |
| D1 commit before Queue enqueue | received/pending, Cron recovers | F8 |
| Duplicate delivery | replayed, one outbox row | F6 |
| Out-of-order push | superseded, newest effect wins | F7 |
| Poison Queue message | DLQ row, siblings ack once | F9 |
| Suspended installation | 503, no state | F10 |
| Revoked installation | ignored, links closed, no mint | F11 |
| Issue closed | evidence only, task unchanged | F12 |

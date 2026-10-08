# Idempotency traces (W02 browser E2E)

- Double Start: two POSTs, one idempotency key `017G487EPA4ZEB6Q3JXS6EBNDJ`, one launch `01F76A4H7DRED88YXNVQXEDB2J`.
- Duplicate wake: two hints for one launch `01F76A4H7DRED88YXNVQXEDB2J`; the durable command is unchanged.
- Duplicate cancel: one control result `Control 01WVQGYFSNX9QHZM6TAT3TXFVT: applied (applied). Expires 2026-08-07T12:02:00.000Z.`; no second control exists.
- No cloud wake value reaches a Terminal command: the launch section renders no helper invocation.

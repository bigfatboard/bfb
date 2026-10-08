# L01 storage and fault evidence

The clean-checkout `pnpm test:l01` gate passed these synthetic assertions against local migration `001_kernel.sql`.

| Test | Observed assertion |
| --- | --- |
| `TestWALTransactionsAndRestartRecovery` | WAL, full synchronization and foreign keys enabled; rollback excludes its row; committed records survive; previously attached observation becomes unknown; database/WAL/SHM remain private |
| `TestMigrationRollbackAndChecksum` | Injected migration failure rolls back; changed checksum and newer migration head fail closed |
| `TestProcessCrashAtMigrationBoundary` | Actual helper process exits during migration; reopening safely commits exactly one migration |
| `TestProcessCrashKeepsCommittedTransactionOnly` | Helper is killed with an open transaction; reopening retains only the committed observation and reports it unknown |
| `TestCorruptAndForeignDatabasePreserved` | Corrupt database bytes remain unchanged and foreign application identity is rejected |
| `TestStorageRejectsSymlinksAndPublicFiles` | Database and auxiliary-file symlinks fail closed with unchanged targets; public file permissions are rejected |
| `TestStateDirectoryWithLiteralSpacesAndUnicode` | SQLite opens the exact literal path without URI reinterpretation |

No migration deletes or recreates a damaged user database. The retained lock-file inode serializes daemon ownership before database access and stale-socket cleanup. Recovery does not assert a provider is alive, kill one, finish a task or release a checkout.

Cloud D1 migrations and business state are unchanged. Credential interfaces do not persist secrets; L08/L04 must implement and prove signed native Keychain access before enrollment.

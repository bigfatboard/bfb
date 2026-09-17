// ABOUTME: Public D1 persistence package entry for migrations and tenant repository primitives.
// ABOUTME: Better Auth tables stay out of F04 and join this chain only in C02+.

export { createAuthorizationContext, createBootstrapContext } from "./auth-context.js";
export type { AuthorizationContext, BootstrapContext, Jurisdiction } from "./auth-context.js";
export {
  applyMigrationsForVerification,
  discoveredSqlFiles,
  listMigrationFiles,
  loadMigrationManifest,
  migrationHead,
  readVerificationMigrationState,
  schemaSnapshot,
} from "./migrations.js";
export type { ApplyOptions, MigrationDatabase, MigrationManifest } from "./migrations.js";
export {
  BootstrapWorkspaceWriter,
  WorkspaceRepository,
  optimisticVersionPredicate,
} from "./workspace-repository.js";
export type { SqlDatabase, WorkspaceRow } from "./workspace-repository.js";
export { adaptD1 } from "./d1-adapter.js";
export type { D1Like, D1StatementLike } from "./d1-adapter.js";
export { adaptBetterSqlite3 } from "./sqlite-adapter.js";
export type { BetterSqliteDatabase, BetterSqliteStatement } from "./sqlite-adapter.js";
export { assertUtcTimestamp } from "./timestamps.js";
export { assertAuthorizationEpoch, assertUlid } from "./primitives.js";
export { tenantFixtureChildren, tenantFixtureItems, workspaces } from "./schema.js";

export const MIGRATION_HEAD = "0023_attention";

// ABOUTME: Caches one WorkspaceHub command lane per workspace and database handle.
// ABOUTME: Prevents per-request hub construction from defeating FIFO serialization.

import type { SqlDatabase } from "@bfb/db";

import { WorkspaceHub } from "./hub.js";

const hubsByDb = new WeakMap<SqlDatabase, Map<string, WorkspaceHub>>();

/**
 * Returns the process-local FIFO hub for a workspace on this SqlDatabase.
 * Production Workers must use this instead of `new WorkspaceHub(db)` per request.
 * Durable Object deployment still owns one instance per workspace at the edge.
 */
export function workspaceHub(db: SqlDatabase, workspaceId: string): WorkspaceHub {
  if (!workspaceId || workspaceId.length === 0) {
    throw new Error("workspaceId is required for hub resolution");
  }
  let byWorkspace = hubsByDb.get(db);
  if (!byWorkspace) {
    byWorkspace = new Map();
    hubsByDb.set(db, byWorkspace);
  }
  let hub = byWorkspace.get(workspaceId);
  if (!hub) {
    hub = new WorkspaceHub(db);
    byWorkspace.set(workspaceId, hub);
  }
  return hub;
}

/** Test helper: drop cached hubs for a database handle. */
export function clearWorkspaceHubs(db: SqlDatabase): void {
  hubsByDb.delete(db);
}

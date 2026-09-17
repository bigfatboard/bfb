// ABOUTME: Implements the WorkspaceHub command lane with FIFO serialization and idempotency.
// ABOUTME: Canonical state remains in D1-shaped SQL accessed through the async SqlDatabase.

import {
  assertAuthorizationEpoch,
  assertUlid,
  assertUtcTimestamp,
  type AuthorizationContext,
  type SqlDatabase,
  WorkspaceRepository,
} from "@bfb/db";

import { randomUlid } from "./ids.js";

export interface HubCommand<TInput, TResult> {
  name: string;
  run: (input: TInput, ctx: HubContext) => Promise<TResult>;
  /** Security commands explicitly project safe audit fields; results must remain non-secret. */
  auditInput?: (input: TInput) => unknown;
  /** One-use security exchanges must not replay a cached success. */
  replay?: "reject";
  /**
   * Extra workspace cursors reserved for commands that commit several
   * cursor-ordered rows (for example an event batch). The command assigns
   * cursors ctx.cursorBase .. ctx.cursorBase + extra - 1 to its own rows in
   * batch order; the hub audit row consumes ctx.cursorBase + extra.
   */
  extraCursors?: (input: TInput) => number;
}

export interface HubContext {
  workspaceId: string;
  db: SqlDatabase;
  now: string;
  actorHumanId?: string | undefined;
  actorDelegationId?: string | undefined;
  actorSystemId?: string | undefined;
  actorRunnerId?: string | undefined;
  authorizationEpoch: number;
  /**
   * First workspace cursor reserved for this command. Single-row commands use
   * exactly this cursor for their audit row; batch commands may assign
   * cursorBase .. cursorBase + extra - 1 to their own rows. Gaps are allowed;
   * the cursor stays monotonic per workspace.
   */
  cursorBase: number;
}

export interface CommandRequest<TInput> {
  workspaceId: string;
  idempotencyKey: string;
  expectedVersion?: number;
  input: TInput;
  actorHumanId?: string;
  actorDelegationId?: string;
  actorSystemId?: string;
  actorRunnerId?: string;
  authorizationEpoch: number;
  now?: string;
}

export type CommandOutcome<TResult> =
  | { ok: true; result: TResult; replayed: boolean; cursor: number }
  | { ok: false; error: { code: string; message: string } };

export interface WorkspaceEvent {
  eventId: string;
  cursor: number;
  kind: string;
  payload: unknown;
  createdAt: string;
}

interface StoredIdempotency<TResult> {
  result: TResult;
  cursor: number;
  authorizationEpoch: number;
  actorHumanId?: string | undefined;
  actorDelegationId?: string | undefined;
  actorSystemId?: string | undefined;
  actorRunnerId?: string | undefined;
}

export class WorkspaceHub {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: SqlDatabase) {}

  async execute<TInput, TResult>(
    command: HubCommand<TInput, TResult>,
    request: CommandRequest<TInput>,
  ): Promise<CommandOutcome<TResult>> {
    try {
      validateCommand(command.name, request);
    } catch (error) {
      return commandFailure(error);
    }
    const run = async (): Promise<CommandOutcome<TResult>> => {
      try {
        return await this.db.withTransaction(async (tx) => {
          const existing = (await tx
            .prepare(
              `SELECT command_name, result_json FROM idempotency_records
               WHERE workspace_id = ? AND idempotency_key = ?`,
            )
            .get(request.workspaceId, request.idempotencyKey)) as
            { command_name: string; result_json: string } | undefined;
          if (existing) {
            if (command.replay === "reject") {
              throw new DomainError("request_rejected", "request rejected");
            }
            if (existing.command_name !== command.name) {
              return {
                ok: false,
                error: {
                  code: "idempotency_command_mismatch",
                  message: "idempotency key is bound to a different command",
                },
              };
            }
            const parsed = JSON.parse(existing.result_json) as StoredIdempotency<TResult>;
            if (
              parsed.authorizationEpoch !== request.authorizationEpoch ||
              (parsed.actorHumanId ?? undefined) !== (request.actorHumanId ?? undefined) ||
              (parsed.actorDelegationId ?? undefined) !==
                (request.actorDelegationId ?? undefined) ||
              (parsed.actorSystemId ?? undefined) !== (request.actorSystemId ?? undefined) ||
              (parsed.actorRunnerId ?? undefined) !== (request.actorRunnerId ?? undefined)
            ) {
              return {
                ok: false,
                error: {
                  code: "idempotency_authority_mismatch",
                  message: "idempotency key is bound to a different authority",
                },
              };
            }
            return {
              ok: true,
              result: parsed.result,
              replayed: true,
              cursor: parsed.cursor,
            };
          }

          const now = request.now ?? new Date().toISOString();
          const base = await this.readNextCursor(tx, request.workspaceId);
          const extra = command.extraCursors ? command.extraCursors(request.input) : 0;
          if (!Number.isSafeInteger(extra) || extra < 0 || extra > MAX_EXTRA_CURSORS) {
            throw new DomainError("invalid_command_request", "invalid cursor reservation");
          }
          const cursor = base + extra;
          const ctx: HubContext = {
            workspaceId: request.workspaceId,
            db: tx,
            now,
            actorHumanId: request.actorHumanId,
            actorDelegationId: request.actorDelegationId,
            actorSystemId: request.actorSystemId,
            actorRunnerId: request.actorRunnerId,
            authorizationEpoch: request.authorizationEpoch,
            cursorBase: base,
          };
          const result = await command.run(request.input, ctx);
          // Queued after the command's own staged writes: D1 batch transactions
          // forbid reads after a queued write, so the reservation lands last.
          await this.writeCursor(tx, request.workspaceId, cursor);
          const eventId = randomUlid();
          const auditId = randomUlid();
          const outboxId = randomUlid();
          const payload = JSON.stringify({
            actor: {
              humanId: request.actorHumanId,
              delegationId: request.actorDelegationId,
              systemId: request.actorSystemId,
              runnerId: request.actorRunnerId,
              authorizationEpoch: request.authorizationEpoch,
            },
            input: command.auditInput ? command.auditInput(request.input) : request.input,
            result,
          });

          await tx
            .prepare(
              `INSERT INTO semantic_events
               (workspace_id, event_id, workspace_cursor, kind, payload_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(request.workspaceId, eventId, cursor, command.name, payload, now);

          await tx
            .prepare(
              `INSERT INTO audit_events
               (workspace_id, audit_id, actor_principal_id, action, payload_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              request.workspaceId,
              auditId,
              request.actorDelegationId ??
                request.actorHumanId ??
                request.actorRunnerId ??
                request.actorSystemId,
              command.name,
              payload,
              now,
            );

          await tx
            .prepare(
              `INSERT INTO outbox_records
               (workspace_id, outbox_id, kind, payload_json, created_at, delivered_at)
               VALUES (?, ?, ?, ?, ?, NULL)`,
            )
            .run(request.workspaceId, outboxId, command.name, payload, now);

          const stored: StoredIdempotency<TResult> = {
            result,
            cursor,
            authorizationEpoch: request.authorizationEpoch,
            actorHumanId: request.actorHumanId,
            actorDelegationId: request.actorDelegationId,
            actorSystemId: request.actorSystemId,
            actorRunnerId: request.actorRunnerId,
          };
          await tx
            .prepare(
              `INSERT INTO idempotency_records
               (workspace_id, idempotency_key, command_name, result_json, created_at)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              request.workspaceId,
              request.idempotencyKey,
              command.name,
              JSON.stringify(stored),
              now,
            );

          return { ok: true, result, replayed: false, cursor };
        });
      } catch (error) {
        return commandFailure(error);
      }
    };

    const scheduled = this.tail.then(run, run);
    this.tail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }

  private async readNextCursor(db: SqlDatabase, workspaceId: string): Promise<number> {
    const row = (await db
      .prepare(`SELECT cursor FROM workspace_cursors WHERE workspace_id = ?`)
      .get(workspaceId)) as { cursor: number } | undefined;
    return (row?.cursor ?? 0) + 1;
  }

  private async writeCursor(db: SqlDatabase, workspaceId: string, cursor: number): Promise<void> {
    await db
      .prepare(
        `INSERT INTO workspace_cursors (workspace_id, cursor) VALUES (?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET cursor = excluded.cursor`,
      )
      .run(workspaceId, cursor);
  }
}

export async function readEventHighWater(
  db: SqlDatabase,
  authorization: AuthorizationContext,
): Promise<number> {
  await assertEventReadScope(db, authorization);
  const row = (await db
    .prepare(`SELECT cursor FROM workspace_cursors WHERE workspace_id = ?`)
    .get(authorization.workspaceId)) as { cursor: number } | undefined;
  const cursor = row?.cursor ?? 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new DomainError("event_history_corrupt", "workspace cursor is invalid");
  }
  return cursor;
}

export async function listWorkspaceEvents(
  db: SqlDatabase,
  authorization: AuthorizationContext,
  options: { afterCursor: number; throughCursor: number; limit?: number },
): Promise<WorkspaceEvent[]> {
  const limit = options.limit ?? 100;
  if (
    !Number.isSafeInteger(options.afterCursor) ||
    options.afterCursor < 0 ||
    !Number.isSafeInteger(options.throughCursor) ||
    options.throughCursor < options.afterCursor ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new DomainError("invalid_event_range", "event replay range is invalid");
  }
  await assertEventReadScope(db, authorization);
  const rows = (await db
    .prepare(
      `SELECT event_id, workspace_cursor, kind, payload_json, created_at
       FROM semantic_events
       WHERE workspace_id = ? AND workspace_cursor > ? AND workspace_cursor <= ?
       ORDER BY workspace_cursor ASC
       LIMIT ?`,
    )
    .all(authorization.workspaceId, options.afterCursor, options.throughCursor, limit)) as Array<{
    event_id: string;
    workspace_cursor: number;
    kind: string;
    payload_json: string;
    created_at: string;
  }>;
  return rows.map((row) => {
    if (!Number.isSafeInteger(row.workspace_cursor) || row.workspace_cursor < 1) {
      throw new DomainError("event_history_corrupt", "event cursor is invalid");
    }
    try {
      return {
        eventId: row.event_id,
        cursor: row.workspace_cursor,
        kind: row.kind,
        payload: JSON.parse(row.payload_json) as unknown,
        createdAt: row.created_at,
      };
    } catch {
      throw new DomainError("event_history_corrupt", "event payload is invalid");
    }
  });
}

async function assertEventReadScope(
  db: SqlDatabase,
  authorization: AuthorizationContext,
): Promise<void> {
  const workspace = await WorkspaceRepository.forAuthorization(db, authorization).getWorkspace();
  if (!workspace) {
    throw new DomainError("workspace_not_found", "workspace not found");
  }
  if (workspace.jurisdiction !== authorization.jurisdiction) {
    throw new DomainError(
      "workspace_jurisdiction_mismatch",
      "workspace jurisdiction does not match the authorization context",
    );
  }
}

const MAX_EXTRA_CURSORS = 256;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:~-]{8,128}$/;
const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

function validateCommand<TInput>(name: string, request: CommandRequest<TInput>): void {
  try {
    assertUlid(request.workspaceId, "workspace id");
    assertAuthorizationEpoch(request.authorizationEpoch);
    if (request.now !== undefined) {
      assertUtcTimestamp(request.now, "command time");
    }
    if (!request.actorHumanId && !request.actorSystemId && !request.actorRunnerId) {
      throw new Error("command actor is required");
    }
    if (request.actorDelegationId && !request.actorHumanId) {
      throw new Error("delegated commands require a human sponsor");
    }
    if (request.actorSystemId && (request.actorHumanId || request.actorDelegationId)) {
      throw new Error("system commands cannot claim a human or delegation actor");
    }
    if (
      request.actorRunnerId &&
      (request.actorHumanId || request.actorDelegationId || request.actorSystemId)
    ) {
      throw new Error("runner commands cannot claim another principal");
    }
    if (request.actorRunnerId) {
      assertUlid(request.actorRunnerId, "runner actor id");
    }
    if (request.actorHumanId) {
      assertUlid(request.actorHumanId, "human actor id");
    }
    if (request.actorDelegationId) {
      assertUlid(request.actorDelegationId, "delegation actor id");
    }
    if (request.actorSystemId) {
      assertUlid(request.actorSystemId, "system actor id");
    }
    if (
      request.expectedVersion !== undefined &&
      (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 1)
    ) {
      throw new Error("invalid expected version");
    }
  } catch (error) {
    throw new DomainError(
      "invalid_command_request",
      error instanceof Error ? error.message : "invalid command request",
    );
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(request.idempotencyKey)) {
    throw new DomainError("invalid_command_request", "invalid idempotency key");
  }
  if (!COMMAND_NAME_PATTERN.test(name)) {
    throw new DomainError("invalid_command_request", "invalid command name");
  }
}

function commandFailure<TResult>(error: unknown): CommandOutcome<TResult> {
  return {
    ok: false,
    error: {
      code:
        error instanceof Error && "code" in error
          ? String((error as { code: string }).code)
          : "command_failed",
      message: error instanceof Error ? error.message : "command failed",
    },
  };
}

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

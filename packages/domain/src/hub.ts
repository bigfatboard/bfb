// ABOUTME: Implements the WorkspaceHub command lane with FIFO serialization and idempotency.
// ABOUTME: Canonical state remains in D1-shaped SQL accessed through the async SqlDatabase.

import type { SqlDatabase } from "@bfb/db";

import { randomUlid } from "./ids.js";

export interface HubCommand<TInput, TResult> {
  name: string;
  run: (input: TInput, ctx: HubContext) => Promise<TResult>;
}

export interface HubContext {
  workspaceId: string;
  db: SqlDatabase;
  now: string;
  actorHumanId?: string | undefined;
  actorDelegationId?: string | undefined;
  authorizationEpoch: number;
}

export interface CommandRequest<TInput> {
  workspaceId: string;
  idempotencyKey: string;
  expectedVersion?: number;
  input: TInput;
  actorHumanId?: string;
  actorDelegationId?: string;
  authorizationEpoch: number;
  now?: string;
}

export type CommandOutcome<TResult> =
  | { ok: true; result: TResult; replayed: boolean; cursor: number }
  | { ok: false; error: { code: string; message: string } };

interface StoredIdempotency<TResult> {
  result: TResult;
  cursor: number;
  authorizationEpoch: number;
  actorHumanId?: string | undefined;
  actorDelegationId?: string | undefined;
}

export class WorkspaceHub {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: SqlDatabase) {}

  async execute<TInput, TResult>(
    command: HubCommand<TInput, TResult>,
    request: CommandRequest<TInput>,
  ): Promise<CommandOutcome<TResult>> {
    const run = async (): Promise<CommandOutcome<TResult>> => {
      try {
        return await this.db.withTransaction(async (tx) => {
          const existing = (await tx
            .prepare(
              `SELECT result_json FROM idempotency_records
               WHERE workspace_id = ? AND idempotency_key = ?`,
            )
            .get(request.workspaceId, request.idempotencyKey)) as
            { result_json: string } | undefined;
          if (existing) {
            const parsed = JSON.parse(existing.result_json) as StoredIdempotency<TResult>;
            if (
              parsed.authorizationEpoch !== request.authorizationEpoch ||
              (parsed.actorHumanId ?? undefined) !== (request.actorHumanId ?? undefined) ||
              (parsed.actorDelegationId ?? undefined) !== (request.actorDelegationId ?? undefined)
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
          const cursor = await this.readNextCursor(tx, request.workspaceId);
          const ctx: HubContext = {
            workspaceId: request.workspaceId,
            db: tx,
            now,
            actorHumanId: request.actorHumanId,
            actorDelegationId: request.actorDelegationId,
            authorizationEpoch: request.authorizationEpoch,
          };
          const result = await command.run(request.input, ctx);
          await this.writeCursor(tx, request.workspaceId, cursor);
          const eventId = randomUlid();
          const auditId = randomUlid();
          const outboxId = randomUlid();
          const payload = JSON.stringify({ input: request.input, result });

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
              request.actorHumanId ?? request.actorDelegationId ?? "system",
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

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

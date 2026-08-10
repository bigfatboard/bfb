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

export class WorkspaceHub {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: SqlDatabase) {}

  async execute<TInput, TResult>(
    command: HubCommand<TInput, TResult>,
    request: CommandRequest<TInput>,
  ): Promise<CommandOutcome<TResult>> {
    const run = async (): Promise<CommandOutcome<TResult>> => {
      const existing = (await this.db
        .prepare(
          `SELECT result_json FROM idempotency_records
           WHERE workspace_id = ? AND idempotency_key = ?`,
        )
        .get(request.workspaceId, request.idempotencyKey)) as { result_json: string } | undefined;
      if (existing) {
        const parsed = JSON.parse(existing.result_json) as {
          result: TResult;
          cursor: number;
        };
        return { ok: true, result: parsed.result, replayed: true, cursor: parsed.cursor };
      }

      try {
        const now = request.now ?? new Date().toISOString();
        const ctx: HubContext = {
          workspaceId: request.workspaceId,
          db: this.db,
          now,
          actorHumanId: request.actorHumanId,
          actorDelegationId: request.actorDelegationId,
          authorizationEpoch: request.authorizationEpoch,
        };
        const result = await command.run(request.input, ctx);
        const cursor = await this.nextCursor(request.workspaceId);
        await this.db
          .prepare(
            `INSERT INTO semantic_events
             (workspace_id, event_id, workspace_cursor, kind, payload_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            request.workspaceId,
            randomUlid(),
            cursor,
            command.name,
            JSON.stringify({ input: request.input, result }),
            now,
          );
        await this.db
          .prepare(
            `INSERT INTO idempotency_records
             (workspace_id, idempotency_key, command_name, result_json, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            request.workspaceId,
            request.idempotencyKey,
            command.name,
            JSON.stringify({ result, cursor }),
            now,
          );
        return { ok: true, result, replayed: false, cursor };
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

  private async nextCursor(workspaceId: string): Promise<number> {
    const row = (await this.db
      .prepare(`SELECT cursor FROM workspace_cursors WHERE workspace_id = ?`)
      .get(workspaceId)) as { cursor: number } | undefined;
    const next = (row?.cursor ?? 0) + 1;
    await this.db
      .prepare(
        `INSERT INTO workspace_cursors (workspace_id, cursor) VALUES (?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET cursor = excluded.cursor`,
      )
      .run(workspaceId, next);
    return next;
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

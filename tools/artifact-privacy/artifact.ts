// ABOUTME: Forwards native artifact D1/R2 operations through disposable authority-loss seams.
// ABOUTME: Keeps canonical snapshots and byte-operation witnesses private while exposing bounded test counters.

import { createArtifactFetchHandler } from "@bfb/artifact-worker";
import { adaptD1, type D1Like, type D1StatementLike } from "@bfb/db";
import { FIX, isUlid } from "@bfb/domain";

export interface ArtifactPrivacyEffects {
  body_reads: number;
  put_calls: number;
  get_calls: number;
  array_buffer_reads: number;
  native_put_stored: boolean;
  revoked: boolean;
  consume_committed: boolean;
  receipt_committed: boolean;
  committed_history_preserved: boolean;
  canonical_unchanged: boolean;
  fk_clean: boolean;
  maximum_bindings: number;
  maximum_statement_bytes: number;
}
type Seam = "before" | "get" | "body" | "put" | "receipt";
type Snapshot = Record<string, Array<Record<string, unknown>>>;
const effects = new Map<string, ArtifactPrivacyEffects>();
const fresh = (): ArtifactPrivacyEffects => ({
  body_reads: 0,
  put_calls: 0,
  get_calls: 0,
  array_buffer_reads: 0,
  native_put_stored: false,
  revoked: false,
  consume_committed: false,
  receipt_committed: false,
  committed_history_preserved: false,
  canonical_unchanged: false,
  fk_clean: false,
  maximum_bindings: 0,
  maximum_statement_bytes: 0,
});
function requireWitness(value: unknown): asserts value {
  if (!value) throw new Error("synthetic artifact witness failed");
}

export async function canonicalSnapshot(binding: D1Like): Promise<Snapshot> {
  const db = adaptD1(binding),
    rows: Snapshot = {};
  const tables = (await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table'
    AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'
    AND name NOT IN ('d1_migrations','rate_limit_buckets') ORDER BY name`,
    )
    .all()) as Array<{ name: string }>;
  for (const { name } of tables) {
    requireWitness(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name));
    rows[name] = (await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()) as Array<
      Record<string, unknown>
    >;
  }
  return rows;
}

export default {
  async fetch(request: Request, environment: unknown): Promise<Response> {
    const bindings = environment as { DB: D1Like; ARTIFACTS: R2Bucket };
    const url = new URL(request.url);
    const lookup = /^\/__c11\/effects\/([0-7][0-9A-HJKMNP-TV-Z]{25})$/u.exec(url.pathname);
    if (request.method === "GET" && lookup) return Response.json(effects.get(lookup[1]!) ?? null);
    const now = request.headers.get("x-v02-test-time") ?? new Date().toISOString();
    const scope = request.headers.get("x-c11-scope"),
      phase = request.headers.get("x-c11-seam") as Seam | null;
    const grantId = request.headers.get("x-c11-task-grant"),
      versionId = request.headers.get("x-c11-version");
    if (
      scope !== null &&
      (scope.length !== 26 || !isUlid(scope) || effects.has(scope) || effects.size >= 64)
    )
      return new Response(null, { status: 400 });
    if (
      phase &&
      (!scope ||
        !grantId ||
        grantId.length !== 26 ||
        !isUlid(grantId) ||
        !["before", "get", "body", "put", "receipt"].includes(phase))
    )
      return new Response(null, { status: 400 });
    const count = fresh();
    if (scope) effects.set(scope, count);
    const raw = bindings.DB,
      db = adaptD1(raw);
    let afterMutation: Snapshot | undefined;
    async function revoke(at: Seam): Promise<void> {
      if (phase !== at || count.revoked) return;
      const before = await canonicalSnapshot(raw);
      const row = before.task_human_grants?.find((candidate) => candidate.id === grantId);
      requireWitness(
        row &&
          row.workspace_id === FIX.workspace &&
          row.human_id === FIX.owner &&
          row.revoked_at === null,
      );
      const expected = structuredClone(before);
      expected.task_human_grants!.find((candidate) => candidate.id === grantId)!.revoked_at = now;
      await db
        .prepare(
          "UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=? AND revoked_at IS NULL",
        )
        .run(now, FIX.workspace, grantId);
      afterMutation = await canonicalSnapshot(raw);
      requireWitness(JSON.stringify(expected) === JSON.stringify(afterMutation));
      count.revoked = true;
      count.committed_history_preserved = at === "receipt";
      const upload = /^\/upload\/([^/]+)$/u.exec(url.pathname),
        view = /^\/view\/([^/]+)\/redeem$/u.exec(url.pathname);
      const table = upload ? "artifact_upload_grants" : "artifact_view_grants";
      const claim = (await db
        .prepare(`SELECT consumed_at FROM ${table} WHERE workspace_id=? AND id=?`)
        .get(FIX.workspace, upload?.[1] ?? view?.[1])) as { consumed_at: string | null } | null;
      count.consume_committed = claim?.consumed_at != null;
    }
    // Preserve actual bound statements in native batch; wrapper identities never reach workerd's batch API.
    const native = new WeakMap<D1StatementLike, D1StatementLike>();
    const sqlFor = new WeakMap<D1StatementLike, string>();
    const measured: D1Like = {
      prepare(sql) {
        count.maximum_statement_bytes = Math.max(
          count.maximum_statement_bytes,
          new TextEncoder().encode(sql).length,
        );
        requireWitness(count.maximum_statement_bytes <= 100_000);
        const wrap = (statement: D1StatementLike): D1StatementLike => {
          const wrapped: D1StatementLike = {
            bind(...parameters) {
              count.maximum_bindings = Math.max(count.maximum_bindings, parameters.length);
              requireWitness(parameters.length <= 100);
              return wrap(statement.bind(...parameters));
            },
            first: (column) => statement.first(column),
            all: () => statement.all(),
            run: () => statement.run(),
          };
          native.set(wrapped, statement);
          sqlFor.set(wrapped, sql);
          return wrapped;
        };
        return wrap(raw.prepare(sql));
      },
      async batch(statements) {
        const receiptBatch = statements.some((statement) =>
          sqlFor.get(statement)?.includes("INSERT INTO artifact_upload_receipts"),
        );
        const result = await raw.batch(
          statements.map((statement) => native.get(statement) ?? statement),
        );
        if (phase === "receipt" && receiptBatch) {
          requireWitness(versionId && versionId.length === 26 && isUlid(versionId));
          const witness = await db
            .prepare(
              `SELECT 1 AS verified FROM artifact_upload_receipts AS receipt
            JOIN artifact_upload_receipt_sources AS source ON source.workspace_id=receipt.workspace_id AND source.version_id=receipt.version_id
            JOIN artifact_audit_outbox AS audit ON audit.workspace_id=source.workspace_id AND audit.id=source.outbox_id
            JOIN artifact_objects AS object ON object.workspace_id=receipt.workspace_id AND object.content_hash=receipt.content_hash
            WHERE receipt.workspace_id=? AND receipt.version_id=? AND object.size=receipt.size
              AND audit.version_id=receipt.version_id AND audit.grant_id=source.grant_id AND audit.action='artifact.upload_verified'`,
            )
            .get(FIX.workspace, versionId);
          requireWitness(witness);
          count.receipt_committed = true;
          await revoke("receipt");
        }
        return result;
      },
    };
    const bucket = new Proxy(bindings.ARTIFACTS, {
      get(target, key) {
        if (key === "put")
          return async (...args: Parameters<R2Bucket["put"]>) => {
            count.put_calls++;
            const written = await target.put(...args);
            count.native_put_stored ||= written !== null;
            await revoke("put");
            return written;
          };
        if (key === "get")
          return async (...args: Parameters<R2Bucket["get"]>) => {
            count.get_calls++;
            const object = await target.get(...args);
            if (phase === "get") requireWitness(object);
            await revoke("get");
            return object
              ? new Proxy(object, {
                  get(body, property) {
                    if (property === "arrayBuffer")
                      return async () => {
                        count.array_buffer_reads++;
                        const bytes = await body.arrayBuffer();
                        await revoke("body");
                        return bytes;
                      };
                    const value = Reflect.get(body, property, body);
                    return typeof value === "function" ? value.bind(body) : value;
                  },
                })
              : null;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const observed = new Proxy(request, {
      get(target, key) {
        if (key === "body" && target.body)
          return new Proxy(target.body, {
            get(body, property) {
              if (property === "getReader")
                return () => {
                  count.body_reads++;
                  return body.getReader();
                };
              const value = Reflect.get(body, property, body);
              return typeof value === "function" ? value.bind(body) : value;
            },
          });
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await revoke("before");
    const response = await createArtifactFetchHandler({ now, db: adaptD1(measured) })(observed, {
      ...bindings,
      ARTIFACTS: bucket,
    } as never);
    if (afterMutation)
      count.canonical_unchanged =
        JSON.stringify(await canonicalSnapshot(raw)) === JSON.stringify(afterMutation);
    count.fk_clean = (await db.prepare("PRAGMA foreign_key_check").all()).length === 0;
    return response;
  },
};

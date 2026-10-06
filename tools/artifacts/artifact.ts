// ABOUTME: Runs the production Artifact Worker upload path with a controllable clock.
// ABOUTME: Real D1 batches and the disposable R2 binding prove the V01 state machine.

import { createArtifactFetchHandler } from "@bfb/artifact-worker";
import { adaptD1, type D1Like, type D1StatementLike } from "@bfb/db";

export interface ArtifactTestBucket {
  put(
    key: string,
    value: Uint8Array,
    options?: {
      sha256?: string;
      onlyIf?: { etagDoesNotMatch?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  head(key: string): Promise<{ size: number; customMetadata?: Record<string, string> } | null>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

type Effects = { body_reads: number; put_calls: number };
const effects = new Map<string, Effects>();

async function awaitCandidateReads(db: D1Like, scope: string): Promise<void> {
  await db
    .prepare("UPDATE v01_read_barriers SET arrivals = arrivals + 1 WHERE scope = ?")
    .bind(scope)
    .run();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const row = (await db
      .prepare("SELECT arrivals FROM v01_read_barriers WHERE scope = ?")
      .bind(scope)
      .first()) as { arrivals: number } | null;
    if (row?.arrivals === 2) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("synthetic candidate-read barrier timed out");
}

function instrumentedDatabase(db: D1Like, scope: string): D1Like {
  const underlying = new WeakMap<D1StatementLike, D1StatementLike>();
  return {
    prepare(sql) {
      let statement = db.prepare(sql);
      const wrapped: D1StatementLike = {
        bind(...params) {
          statement = statement.bind(...params);
          underlying.set(wrapped, statement);
          return wrapped;
        },
        async first(column) {
          const result = await statement.first(column);
          if (sql.includes("FROM artifact_upload_grants AS g"))
            await awaitCandidateReads(db, scope);
          return result;
        },
        all: () => statement.all(),
        run: () => statement.run(),
      };
      underlying.set(wrapped, statement);
      return wrapped;
    },
    batch: (statements) =>
      db.batch(statements.map((statement) => underlying.get(statement) ?? statement)),
  };
}

function observedRequest(request: Request, count: Effects): Request {
  return new Proxy(request, {
    get(target, key) {
      if (key === "body" && target.body) {
        const body = target.body;
        return new Proxy(body, {
          get(stream, property) {
            if (property === "getReader")
              return () => {
                count.body_reads += 1;
                return stream.getReader();
              };
            const value = Reflect.get(stream, property, stream);
            return typeof value === "function" ? value.bind(stream) : value;
          },
        });
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export default {
  async fetch(request: Request, env: unknown): Promise<Response> {
    const now = request.headers.get("x-v01-test-time") ?? "2026-09-17T12:00:00.000Z";
    const bindings = env as { DB: D1Like; ARTIFACTS: ArtifactTestBucket };
    const url = new URL(request.url);
    const read = /^\/__v01\/effects\/([0-9A-HJKMNP-TV-Z]{26})$/.exec(url.pathname);
    if (read && request.method === "GET")
      return Response.json(effects.get(read[1]!) ?? { body_reads: 0, put_calls: 0 });
    const scope = request.headers.get("x-v01-race-scope");
    if (!scope) return createArtifactFetchHandler({ now })(request, env as never);
    if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(scope) || effects.size >= 128)
      return new Response("invalid synthetic scope", { status: 400 });
    const count = effects.get(scope) ?? { body_reads: 0, put_calls: 0 };
    effects.set(scope, count);
    const bucket = new Proxy(bindings.ARTIFACTS, {
      get(target, key) {
        if (key === "put")
          return (...args: Parameters<ArtifactTestBucket["put"]>) => {
            count.put_calls += 1;
            return target.put(...args);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return createArtifactFetchHandler({
      now,
      db: adaptD1(instrumentedDatabase(bindings.DB, scope)),
    })(observedRequest(request, count), { ...bindings, ARTIFACTS: bucket } as never);
  },
};

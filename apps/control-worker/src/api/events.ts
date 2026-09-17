// ABOUTME: Serves runner event-batch ingest and browser ledger replay through shared domain commands.
// ABOUTME: Raw runner claims never enter the ledger; attribution is derived server-side by E01 ingest.

import { createAuthorizationContext } from "@bfb/db";
import {
  assertLedgerBrowserAccess,
  DomainError,
  EVENT_BATCH_LIMIT,
  EVENT_BODY_LIMIT,
  ingestRunnerEventsCommand,
  listLedgerEvents,
  loadPrincipal,
  randomUlid,
  readLedgerHighWater,
  rejectRunnerRequest,
  runnerId,
  runnerObject,
  type HubCommand,
} from "@bfb/domain";

import type { BrowserPrincipal } from "../auth/session.js";
import {
  executeRunnerCommand,
  guardRunnerTransport,
  readPossessedRunnerRequest,
  type RunnerApiDeps,
} from "./runners.js";

const nativePattern =
  /^\/runner\/workspaces\/([^/]+)\/runners\/([^/]+)\/events\/ingest$/;

export function isRunnerEventPath(path: string): boolean {
  return nativePattern.test(path);
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache", "referrer-policy": "no-referrer" },
  });
}

function rejected(): Response {
  return response({ error: "request_rejected", message: "request rejected" }, 403);
}

/** Runner batches arrive over the C06 possession channel; L06 will call this endpoint. */
export async function handleRunnerEventApi(
  request: Request,
  deps: RunnerApiDeps,
): Promise<Response> {
  try {
    const url = new URL(request.url),
      match = nativePattern.exec(url.pathname);
    if (!match?.[1] || !match[2] || url.search) rejectRunnerRequest();
    const workspaceId = runnerId(match[1]),
      runner = runnerId(match[2]);
    await guardRunnerTransport(request, deps, workspaceId, runner, "events/ingest");
    if (request.method !== "POST") rejectRunnerRequest();
    const { principal, bytes } = await readPossessedRunnerRequest(
      request,
      deps,
      workspaceId,
      runner,
      EVENT_BODY_LIMIT,
    );
    const body = runnerObject(parseJson(bytes), ["schema_version", "events"]);
    if (body.schema_version !== 1 || !Array.isArray(body.events)) rejectRunnerRequest();
    if (body.events.length < 1 || body.events.length > EVENT_BATCH_LIMIT) rejectRunnerRequest();
    const run = <I, R>(command: HubCommand<I, R>, input: I) =>
      executeRunnerCommand(deps, command, {
        workspaceId,
        actorRunnerId: runner,
        authorizationEpoch: principal.authorizationEpoch,
        now: deps.now,
        idempotencyKey: randomUlid(),
        input,
      });
    const result = await run(ingestRunnerEventsCommand, {
      principal,
      events: body.events,
    });
    return response(result);
  } catch {
    return rejected();
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    ) as unknown;
  } catch {
    rejectRunnerRequest();
  }
}

export interface EventBrowserDeps extends RunnerApiDeps {
  principal: BrowserPrincipal;
  workspaceId: string;
}

/** Browser replay reads committed ledger envelopes directly from D1; replay never deletes rows. */
export async function handleEventBrowserApi(
  request: Request,
  deps: EventBrowserDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const workspaceId = runnerId(deps.workspaceId);
  const principal = await loadPrincipal(deps.db, workspaceId, deps.principal.humanId);
  await assertLedgerBrowserAccess(
    deps.db,
    workspaceId,
    deps.principal.humanId,
    principal.authorizationEpoch,
  );
  const authorization = createAuthorizationContext({
    workspaceId,
    principalId: deps.principal.humanId,
    authorizationEpoch: principal.authorizationEpoch,
    jurisdiction: deps.jurisdiction,
  });
  const prefix = `/api/v1/workspaces/${workspaceId}`;
  if (url.pathname === `${prefix}/events/high-water` && request.method === "GET") {
    if (url.search) throw new DomainError("invalid_argument", "high-water takes no parameters");
    return Response.json({
      schema_version: 1,
      workspace_id: workspaceId,
      high_water_cursor: await readLedgerHighWater(deps.db, authorization),
    });
  }
  if (url.pathname === `${prefix}/events` && request.method === "GET") {
    const afterCursor = integerParam(url, "after_cursor", 0);
    const highWater = await readLedgerHighWater(deps.db, authorization);
    const throughCursor = integerParam(url, "through_cursor", highWater);
    const limit = integerParam(url, "limit", 100);
    const events = await listLedgerEvents(deps.db, authorization, {
      afterCursor,
      throughCursor,
      limit,
    });
    const lastCursor =
      events.length > 0 ? (events[events.length - 1]?.workspace_cursor as number) : afterCursor;
    return Response.json({
      schema_version: 1,
      workspace_id: workspaceId,
      high_water_cursor: highWater,
      events,
      has_more: lastCursor < throughCursor,
    });
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}

function integerParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^[0-9]{1,16}$/.test(raw)) {
    throw new DomainError("invalid_argument", `query parameter ${name} is invalid`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new DomainError("invalid_argument", `query parameter ${name} is invalid`);
  }
  return value;
}

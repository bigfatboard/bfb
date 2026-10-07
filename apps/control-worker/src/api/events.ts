// ABOUTME: Serves runner event-batch ingest while holding admitted public ledger-position reads.
// ABOUTME: Raw runner claims never enter the ledger; attribution is derived server-side by E01 ingest.

import { decodeRunnerEventBatch } from "@bfb/protocol";
import {
  assertLedgerBrowserAccess,
  DomainError,
  EVENT_BATCH_LIMIT,
  EVENT_BODY_LIMIT,
  ingestRunnerEventsCommand,
  loadPrincipal,
  randomUlid,
  rejectRunnerRequest,
  runnerId,
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
  /^\/runner\/workspaces\/([^/]+)\/runners\/([^/]+)\/events\/(ingest|capabilities)$/;

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
    const surface = `events/${match[3]}`;
    await guardRunnerTransport(request, deps, workspaceId, runner, surface);
    if (request.method !== (match[3] === "capabilities" ? "GET" : "POST")) rejectRunnerRequest();
    const { principal, bytes } = await readPossessedRunnerRequest(
      request,
      deps,
      workspaceId,
      runner,
      EVENT_BODY_LIMIT,
    );
    if (match[3] === "capabilities") {
      if (bytes.length !== 0) rejectRunnerRequest();
      return response({ schema_version: 1, accepted_event_versions: [1, 2] });
    }
    const decoded = decodeRunnerEventBatch(bytes);
    if (!decoded.ok) rejectRunnerRequest();
    const encodedEvents = decoded.value.events;
    const events = encodedEvents.map((item) => parseJson(Buffer.from(item)));
    if (events.length < 1 || events.length > EVENT_BATCH_LIMIT) rejectRunnerRequest();
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
      events,
      encodedEvents,
    });
    return response(result);
  } catch (error) {
    if (error instanceof SyntaxError) return rejected();
    if (
      error instanceof DomainError &&
      ["request_rejected", "invalid_json", "body_too_large", "rate_limited"].includes(error.code)
    ) {
      return rejected();
    }
    return response(
      { error: "event_ingest_unavailable", message: "event ingest temporarily unavailable" },
      503,
    );
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

/** Public raw-position delivery is held after existing browser and pure range admission. */
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
  const prefix = `/api/v1/workspaces/${workspaceId}`;
  if (url.pathname === `${prefix}/events/high-water` && request.method === "GET") {
    if (url.search) throw new DomainError("invalid_argument", "high-water takes no parameters");
    return unavailable();
  }
  if (url.pathname === `${prefix}/events` && request.method === "GET") {
    const afterCursor = integerParam(url, "after_cursor", 0);
    const throughCursor = integerParam(url, "through_cursor", afterCursor);
    const limit = integerParam(url, "limit", 100);
    if (throughCursor < afterCursor || limit < 1 || limit > 100) {
      throw new DomainError("invalid_event_range", "ledger replay range is invalid");
    }
    return unavailable();
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}

function unavailable(): Response {
  return response({ error: "request_rejected", message: "event feeds are unavailable" }, 409);
}

function integerParam(url: URL, name: string, fallback: number): number {
  const values = url.searchParams.getAll(name);
  if (values.length > 1)
    throw new DomainError("invalid_argument", `query parameter ${name} is invalid`);
  const raw = values[0] ?? null;
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

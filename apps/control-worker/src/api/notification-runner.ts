// ABOUTME: Serves runner macOS notification pull/ack over request-bound possession auth.
// ABOUTME: Responses carry opaque delivery IDs only; task text never crosses this transport.

import {
  ackMacosNotifications,
  DomainError,
  pullMacosNotifications,
  runnerId,
  rejectRunnerRequest,
  runnerObject,
} from "@bfb/domain";

import { readBoundedJson } from "./request.js";
import { guardRunnerTransport, readPossessedRunnerRequest, type RunnerApiDeps } from "./runners.js";

const targetPattern =
  /^\/runner\/workspaces\/([^/]+)\/runners\/([^/]+)\/notifications\/(pull|ack)$/;

export function isNotificationRunnerPath(path: string): boolean {
  return targetPattern.test(path);
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

export async function handleNotificationRunnerApi(
  request: Request,
  deps: RunnerApiDeps,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const target = targetPattern.exec(url.pathname);
    if (!target?.[1] || !target[2] || !target[3] || url.search) rejectRunnerRequest();
    if (request.method !== "POST") rejectRunnerRequest();
    const workspaceId = runnerId(target[1]);
    const runner = runnerId(target[2]);
    const action = target[3];
    await guardRunnerTransport(request, deps, workspaceId, runner, "notification-runner");
    const { principal, bytes } = await readPossessedRunnerRequest(
      request,
      deps,
      workspaceId,
      runner,
      8192,
    );
    if (action === "pull") {
      const input = runnerObject(
        await readBoundedJson(new Request(request.url, { method: "POST", body: bytes }), 8192),
        [],
      );
      if (Object.keys(input).length !== 0) rejectRunnerRequest();
      return response(await pullMacosNotifications(deps.db, principal, deps.now));
    }
    const input = runnerObject(
      await readBoundedJson(new Request(request.url, { method: "POST", body: bytes }), 8192),
      ["delivery_ids"],
    );
    if (!Array.isArray(input.delivery_ids)) rejectRunnerRequest();
    return response(
      await ackMacosNotifications(
        deps.db,
        principal,
        input.delivery_ids as string[],
        deps.now,
      ),
    );
  } catch (error) {
    if (error instanceof DomainError) {
      return response({ error: error.code, message: "request rejected" }, 400);
    }
    return response({ error: "request_rejected", message: "request rejected" }, 403);
  }
}

// ABOUTME: Serves current-human discussion creation, history, intervention and decision APIs.
// ABOUTME: Sends every mutation through WorkspaceHub and exposes no public participant-identity or provider-dispatch override.

import { createAuthorizationContext } from "@bfb/db";
import {
  decodeWireDocument,
  type DiscussionChangeRequest,
  type DiscussionCreateRequest,
  type WireDocumentName,
} from "@bfb/protocol";
import {
  changeDiscussionCommand,
  createDiscussionCommand,
  DomainError,
  isUlid,
  listTaskDiscussions,
  loadPrincipal,
  randomUlid,
  readHumanDiscussion,
  type HubCommand,
} from "@bfb/domain";

import { executeWorkspaceCommand } from "../hub-client.js";
import { readBoundedBytes } from "./request.js";
import type { WorkApiDeps } from "./work.js";

async function wire<T>(request: Request, name: WireDocumentName): Promise<T> {
  const decoded = decodeWireDocument(name, await readBoundedBytes(request, 65_536));
  if (!decoded.ok) throw new DomainError("invalid_argument", "discussion request is invalid");
  return decoded.value as T;
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export async function handleDiscussionApi(request: Request, deps: WorkApiDeps): Promise<Response> {
  if (!isUlid(deps.workspaceId)) return json({ error: "not_found" }, 404);
  const url = new URL(request.url),
    base = `/api/v1/workspaces/${deps.workspaceId}`;
  const task = new RegExp(`^${base}/tasks/([^/]+)/discussions$`).exec(url.pathname)?.[1];
  const id = new RegExp(`^${base}/discussions/([^/]+)$`).exec(url.pathname)?.[1];
  if ((!task && !id) || (task && !isUlid(task)) || (id && !isUlid(id)))
    return json({ error: "not_found" }, 404);
  const principal = await loadPrincipal(deps.db, deps.workspaceId, deps.principal.humanId);
  const hubDeps = {
    db: deps.db,
    workspaceHubNs: deps.workspaceHubNs,
    authorization: createAuthorizationContext({
      workspaceId: deps.workspaceId,
      principalId: principal.humanId,
      authorizationEpoch: principal.authorizationEpoch,
      jurisdiction: deps.jurisdiction,
    }),
  };
  async function execute<I, R>(command: HubCommand<I, R>, input: I) {
    const outcome = await executeWorkspaceCommand(hubDeps, command, {
      workspaceId: deps.workspaceId,
      idempotencyKey: randomUlid(),
      actorHumanId: principal.humanId,
      authorizationEpoch: principal.authorizationEpoch,
      now: deps.now,
      input,
    });
    if (outcome.ok) return json(outcome);
    const code = outcome.error.code;
    return json(
      outcome,
      code === "forbidden"
        ? 403
        : code === "not_found"
          ? 404
          : code === "invalid_argument" || code === "bound_exceeded"
            ? 400
            : 409,
    );
  }
  if (request.method === "GET") {
    try {
      if (task) {
        if ([...url.searchParams.keys()].some((key) => key !== "cursor" && key !== "limit"))
          throw new DomainError("invalid_argument", "discussion pagination is invalid");
        const cursor = url.searchParams.get("cursor"),
          limit = url.searchParams.get("limit");
        return json(
          await listTaskDiscussions(deps.db, principal, task, {
            ...(cursor === null ? {} : { cursor }),
            ...(limit === null ? {} : { limit: Number(limit) }),
          }),
        );
      }
      if (url.search)
        throw new DomainError(
          "invalid_argument",
          "discussion read does not accept scope overrides",
        );
      return json({ discussion: await readHumanDiscussion(deps.db, principal, id!, deps.now) });
    } catch (error) {
      if (
        error instanceof DomainError &&
        (error.code === "forbidden" || error.code === "not_found")
      )
        return json({ error: "not_found" }, 404);
      throw error;
    }
  }
  if (request.method !== "POST" || url.search) return json({ error: "not_found" }, 404);
  if (task) {
    const input = await wire<DiscussionCreateRequest>(request, "discussion-create-request");
    if (input.task_id !== task)
      throw new DomainError("invalid_argument", "discussion task binding is invalid");
    return execute(createDiscussionCommand, input);
  }
  const input = await wire<DiscussionChangeRequest>(request, "discussion-change-request");
  if (input.discussion_id !== id)
    throw new DomainError("invalid_argument", "discussion path binding is invalid");
  return execute(changeDiscussionCommand, input);
}

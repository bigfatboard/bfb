// ABOUTME: Authenticates runner channel handshakes, durable pulls and sanitized inventory with fresh request possession.
// ABOUTME: Keeps proofs out of URLs, socket attachments and business payloads while routing mutations through WorkspaceHub.

import { createHash } from "node:crypto";
import { createAuthorizationContext, WorkspaceRepository } from "@bfb/db";
import {
  randomUlid,
  rejectRunnerRequest,
  replaceRunnerInventoryCommand,
  runnerId,
  runnerObject,
  RUNNER_INVENTORY_LIMIT,
  type RunnerPrincipal,
} from "@bfb/domain";
import { decodeWireDocument, type RunnerInventory } from "@bfb/protocol";

import { workspaceNamespaceForJurisdiction } from "../env.js";
import {
  authenticateRunnerRequest,
  executeRunnerCommand,
  guardRunnerTransport,
  type RunnerApiDeps,
} from "./runners.js";
import { readBoundedJson } from "./request.js";

const targetPattern =
  /^\/runner\/workspaces\/([^/]+)\/runners\/([^/]+)\/(connect|commands\/pull|inventory)$/;

export function isRunnerChannelPath(path: string): boolean {
  return targetPattern.test(path);
}

async function hub(deps: RunnerApiDeps, principal: RunnerPrincipal): Promise<DurableObjectStub> {
  if (!deps.workspaceHubNs) rejectRunnerRequest();
  const authorization = createAuthorizationContext({
    workspaceId: principal.workspaceId,
    principalId: principal.runnerId,
    authorizationEpoch: principal.authorizationEpoch,
    jurisdiction: deps.jurisdiction,
  });
  const workspace = await WorkspaceRepository.forAuthorization(
    deps.db,
    authorization,
  ).getWorkspace();
  if (!workspace || workspace.jurisdiction !== deps.jurisdiction) rejectRunnerRequest();
  const namespace = workspaceNamespaceForJurisdiction(deps.workspaceHubNs, workspace.jurisdiction);
  return namespace.get(namespace.idFromName(workspace.id));
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

export async function handleRunnerChannelApi(
  request: Request,
  deps: RunnerApiDeps,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const target = targetPattern.exec(url.pathname);
    if (!target?.[1] || !target[2] || !target[3] || url.search) rejectRunnerRequest();
    const workspaceId = runnerId(target[1]);
    const runner = runnerId(target[2]);
    const action = target[3];
    await guardRunnerTransport(request, deps, workspaceId, runner, action);
    if (
      (action === "connect" && request.method !== "GET") ||
      (action !== "connect" && request.method !== "POST")
    )
      rejectRunnerRequest();
    if (
      action === "connect" &&
      (request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
        request.headers.get("sec-websocket-protocol") !== "bfb.runner.v1")
    )
      rejectRunnerRequest();
    const encoded = request.headers.get("x-bfb-runner-proof");
    if (!encoded || encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded))
      rejectRunnerRequest();
    const proofBytes = Buffer.from(encoded, "base64url");
    if (proofBytes.toString("base64url") !== encoded) rejectRunnerRequest();
    const proofText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(proofBytes);
    const proof = runnerObject(JSON.parse(proofText), [
      "challenge_id",
      "server_nonce",
      "signature",
      "token",
    ]);
    if (
      typeof proof.token !== "string" ||
      typeof proof.server_nonce !== "string" ||
      typeof proof.signature !== "string"
    )
      rejectRunnerRequest();
    if (
      JSON.stringify({
        challenge_id: proof.challenge_id,
        server_nonce: proof.server_nonce,
        signature: proof.signature,
        token: proof.token,
      }) !== proofText
    )
      rejectRunnerRequest();
    // Read exactly once; authentication binds these bytes, not reserialized JSON.
    const limit = action === "inventory" ? RUNNER_INVENTORY_LIMIT : 8192;
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limit) {
          await reader.cancel();
          rejectRunnerRequest();
        }
        chunks.push(chunk.value);
      }
    }
    if (action === "connect" && size !== 0) rejectRunnerRequest();
    const bytes = Buffer.concat(chunks);
    const principal = await authenticateRunnerRequest(
      deps,
      workspaceId,
      {
        runnerId: runner,
        challengeId: runnerId(proof.challenge_id),
        serverNonce: proof.server_nonce,
        signature: proof.signature,
        origin: deps.appOrigin,
      },
      proof.token,
      {
        method: request.method,
        path: url.pathname,
        body_sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    );
    if (action === "connect") {
      const stub = await hub(deps, principal);
      return stub.fetch("https://bfb-hub.internal/runner/connect", {
        method: "GET",
        headers: {
          upgrade: "websocket",
          "sec-websocket-protocol": "bfb.runner.v1",
          "x-bfb-runner-principal": JSON.stringify(principal),
        },
      });
    }
    if (action === "commands/pull") {
      const input = runnerObject(
        await readBoundedJson(new Request(request.url, { method: "POST", body: bytes }), 8192),
        ["after_command_id"],
      );
      const after =
        input.after_command_id === undefined ? undefined : runnerId(input.after_command_id);
      const stub = await hub(deps, principal);
      return stub.fetch("https://bfb-hub.internal/runner/pull", {
        method: "POST",
        body: JSON.stringify({ principal, after }),
      });
    }
    const decoded = decodeWireDocument("runner-inventory", bytes);
    if (!decoded.ok) rejectRunnerRequest();
    const result = await executeRunnerCommand(deps, replaceRunnerInventoryCommand, {
      workspaceId,
      actorRunnerId: runner,
      authorizationEpoch: principal.authorizationEpoch,
      now: deps.now,
      idempotencyKey: randomUlid(),
      input: { principal, inventory: decoded.value as RunnerInventory },
    });
    return response(result);
  } catch {
    return response({ error: "request_rejected", message: "request rejected" }, 403);
  }
}

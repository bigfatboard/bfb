// ABOUTME: Proves the post-deploy smoke exercises authenticated handlers.
// ABOUTME: Stub origins only; a smoke that never authenticates fails this suite.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const toolDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(toolDir, "../..");
const script = resolve(toolDir, "smoke-commands.mjs");

const VALID = `bfb_cli_${"A".repeat(43)}`;

/**
 * Serves the deployed CLI surface. `sessionWithValid` is the status for
 * GET /api/v1/cli/session carrying the valid credential: 200 on a healthy
 * deployment, 500 when authenticated handlers are broken behind the
 * rejection checks.
 */
function startStub(sessionWithValid) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://stub.test");
    let status = 404;
    let body = { error: "not_found" };
    if (request.method === "GET" && url.pathname === "/healthz") {
      status = 200;
      body = { ok: true, worker_first: true, environment: "stub" };
    } else if (request.method === "GET" && url.pathname === "/api/v1/cli/version") {
      status = 200;
      body = { api_version: "1", wire_protocol: "bfb-wire/1", cli_min_version: "0.1.0" };
    } else if (request.method === "GET" && url.pathname === "/api/v1/cli/session") {
      if (request.headers.authorization === `Bearer ${VALID}`) {
        status = sessionWithValid;
        body =
          sessionWithValid === 200
            ? {
                human_id: "stub-human",
                workspace_id: "stub-workspace",
                binding_id: "stub-binding",
                scopes: ["bfb:read", "bfb:task:write"],
              }
            : { error: "request_failed" };
      } else {
        status = 401;
        body = { error: "unauthenticated" };
      }
    } else if (request.method === "GET" && url.pathname === "/api/v1/cli/projects") {
      if (request.headers.authorization === `Bearer ${VALID}`) {
        status = 200;
        body = { projects: [] };
      } else {
        status = 401;
        body = { error: "unauthenticated" };
      }
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => done(server));
  });
}

/**
 * Runs the smoke script without blocking the event loop: a synchronous
 * spawn would deadlock, because the child fetches the stub server that
 * lives on this process's loop.
 */
function runSmoke(origin, credential) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, "--origin", origin], {
      cwd: root,
      env: {
        ...process.env,
        ...(credential === undefined ? {} : { BFB_SMOKE_CREDENTIAL: credential }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => done({ status: 1, stderr: String(error) }));
    child.on("exit", (status) => done({ status: status ?? 1, stderr }));
  });
}

function stubOrigin(server) {
  const address = server.address();
  assert.ok(address && typeof address === "object", "stub listens on loopback");
  return `http://127.0.0.1:${address.port}`;
}

test("a valid credential against a healthy origin passes", async () => {
  const server = await startStub(200);
  try {
    const run = await runSmoke(stubOrigin(server), VALID);
    assert.equal(run.status, 0, `healthy smoke passes: ${run.stderr}`);
  } finally {
    server.close();
  }
});

test("an authenticated-handler failure fails the smoke", async () => {
  const server = await startStub(500);
  try {
    const run = await runSmoke(stubOrigin(server), VALID);
    assert.notEqual(run.status, 0, "a 500 on the authenticated session must fail the smoke");
  } finally {
    server.close();
  }
});

test("a missing credential fails closed instead of downgrading to rejection checks", async () => {
  const server = await startStub(200);
  try {
    const run = await runSmoke(stubOrigin(server), undefined);
    assert.notEqual(run.status, 0, "smoke without a credential must not pass");
  } finally {
    server.close();
  }
});

test("a malformed credential fails closed", async () => {
  const server = await startStub(200);
  try {
    const run = await runSmoke(stubOrigin(server), "not-a-credential");
    assert.notEqual(run.status, 0, "smoke with a malformed credential must not pass");
  } finally {
    server.close();
  }
});

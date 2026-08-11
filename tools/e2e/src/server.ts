// ABOUTME: Local E2E HTTP server that mounts createControlApp against fixture DB plus the web SPA.
// ABOUTME: Prints FIX.workspace and listens on a fixed port so Playwright can drive real browser flows.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, type ViteDevServer } from "vite";

import { FIX } from "@bfb/domain";

import { openDomainDb } from "../../../packages/domain/test/helpers.js";
import {
  isWorkerFirstPath,
  validateControlEnv,
  type ControlBindings,
} from "../../../apps/control-worker/src/env.js";
import { createTestWorkspaceHubNamespace } from "../../../apps/control-worker/src/hub-client.js";
import { createControlApp } from "../../../apps/control-worker/src/routes.js";
import type { SqlDatabase } from "@bfb/db";

const PORT = Number(process.env.BFB_E2E_PORT ?? "4173");
const HOST = process.env.BFB_E2E_HOST ?? "127.0.0.1";
const ORIGIN = `http://${HOST}:${PORT}`;
const NOW = "2026-08-07T12:00:00Z";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const webRoot = path.join(rootDir, "apps/web");

function fakeBinding<T extends object>(label: string): T {
  return { __synthetic: label } as unknown as T;
}

function controlBindings(db: SqlDatabase): ControlBindings {
  return {
    DB: fakeBinding<D1Database>("db"),
    ARTIFACTS: fakeBinding<R2Bucket>("r2"),
    ASSETS: fakeBinding<Fetcher>("assets"),
    JOBS: fakeBinding<Queue>("jobs"),
    JOBS_DLQ: fakeBinding<Queue>("dlq"),
    WORKSPACE_HUB: createTestWorkspaceHubNamespace(db),
    APP_ORIGIN: ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  };
}

function shouldHandleOnControl(pathname: string): boolean {
  if (pathname === "/healthz") {
    return true;
  }
  return isWorkerFirstPath(pathname);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function forwardToControl(
  req: IncomingMessage,
  res: ServerResponse,
  app: ReturnType<typeof createControlApp>,
  bindings: ControlBindings,
): Promise<void> {
  const url = new URL(req.url ?? "/", ORIGIN);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else {
      headers.set(key, value);
    }
  }

  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await readBody(req) : undefined;
  const request = new Request(url, {
    method,
    headers,
    body: body && body.length > 0 ? body : undefined,
  });

  const response = await app.fetch(request, bindings);
  res.statusCode = response.status;
  const setCookies: string[] = [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      setCookies.push(value);
      return;
    }
    res.setHeader(key, value);
  });
  if (setCookies.length === 1) {
    res.setHeader("set-cookie", setCookies[0]!);
  } else if (setCookies.length > 1) {
    res.setHeader("set-cookie", setCookies);
  }
  const ab = Buffer.from(await response.arrayBuffer());
  res.end(ab);
}

async function serveSpa(
  req: IncomingMessage,
  res: ServerResponse,
  vite: ViteDevServer,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    vite.middlewares(req, res, (error?: unknown) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  if (res.writableEnded) {
    return;
  }

  const url = req.url ?? "/";
  const indexHtmlPath = path.join(webRoot, "index.html");
  const fs = await import("node:fs/promises");
  let template = await fs.readFile(indexHtmlPath, "utf8");
  template = await vite.transformIndexHtml(url, template);
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(template);
}

async function main(): Promise<void> {
  const db = await openDomainDb();
  const bindings = controlBindings(db);
  const validated = validateControlEnv(bindings);
  const app = createControlApp(validated, { db, now: NOW });

  const vite = await createViteServer({
    configFile: path.join(webRoot, "vite.config.ts"),
    root: webRoot,
    server: {
      middlewareMode: true,
      hmr: false,
    },
    appType: "custom",
    logLevel: "error",
  });

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const pathname = new URL(req.url ?? "/", ORIGIN).pathname;
        if (shouldHandleOnControl(pathname)) {
          await forwardToControl(req, res, app, bindings);
          return;
        }
        await serveSpa(req, res, vite);
      } catch (error) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "text/plain; charset=utf-8");
        }
        const message = error instanceof Error ? error.message : "e2e server error";
        res.end(message);
        console.error("[e2e-server]", error);
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, () => resolve());
  });

  console.log(`BFB_E2E_READY ${ORIGIN}`);
  console.log(`BFB_E2E_WORKSPACE ${FIX.workspace}`);
  console.log(`BFB_E2E_PROJECT_A ${FIX.projectA}`);
  console.log(`BFB_E2E_PROJECT_B ${FIX.projectB}`);
  console.log(`BFB_E2E_CLIENT ${FIX.client}`);

  const shutdown = async () => {
    server.close();
    await vite.close();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

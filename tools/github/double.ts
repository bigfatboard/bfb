// ABOUTME: Local GitHub App and REST double serving recorded X04 fixtures.
// ABOUTME: Records sanitized request classes only; tokens and keys never persist.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type DoubleAuth = "jwt" | "canary" | "wrong" | "missing";

export interface DoubleRequest {
  method: string;
  path: string;
  auth: DoubleAuth;
  installation_id: string | null;
  at: string;
}

export class GitHubDouble {
  private server: Server | null = null;
  private readonly requests: DoubleRequest[] = [];
  private repository: Record<string, unknown> = {};

  constructor(
    private readonly fixturesDir: string,
    private readonly canary: string,
  ) {}

  async start(): Promise<string> {
    const raw = await readFile(resolve(this.fixturesDir, "rest/repository.json"), "utf8");
    this.repository = JSON.parse(raw) as Record<string, unknown>;
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        respond(response, 500, { error: "double_failed" });
      });
    });
    await new Promise<void>((done) => {
      this.server?.listen(0, "127.0.0.1", () => done());
    });
    const address = this.server?.address();
    if (!address || typeof address === "string") {
      throw new Error("github double did not bind a port");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((done, reject) => {
      this.server?.close((error) => (error ? reject(error) : done()));
    });
    this.server = null;
  }

  log(): DoubleRequest[] {
    return [...this.requests];
  }

  private classify(request: IncomingMessage): DoubleAuth {
    const header = request.headers.authorization ?? "";
    if (!header) {
      return "missing";
    }
    if (header === `Bearer ${this.canary}`) {
      return "canary";
    }
    if (/^Bearer eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(header)) {
      return "jwt";
    }
    return "wrong";
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://double.test");
    const mint = /^\/app\/installations\/([^/]+)\/access_tokens$/.exec(url.pathname);
    if (request.method === "POST" && mint?.[1]) {
      const auth = this.classify(request);
      this.requests.push({
        method: "POST",
        path: url.pathname,
        auth,
        installation_id: mint[1],
        at: new Date().toISOString(),
      });
      if (auth !== "jwt") {
        respond(response, 401, { message: "Bad credentials" });
        return;
      }
      respond(response, 201, {
        token: this.canary,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        permissions: { metadata: "read", pull_requests: "read", checks: "read" },
      });
      return;
    }
    const repository = /^\/repositories\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && repository?.[1]) {
      const auth = this.classify(request);
      this.requests.push({
        method: "GET",
        path: url.pathname,
        auth,
        installation_id: null,
        at: new Date().toISOString(),
      });
      if (auth !== "canary") {
        respond(response, 401, { message: "Bad credentials" });
        return;
      }
      respond(response, 200, { ...this.repository, id: Number(repository[1]) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/__admin/requests") {
      respond(response, 200, { requests: this.requests });
      return;
    }
    respond(response, 404, { message: "Not Found" });
  }
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

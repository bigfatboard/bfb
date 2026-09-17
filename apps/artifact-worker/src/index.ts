// ABOUTME: Serves the cookie-less Artifact Worker origin with bounded upload grants.
// ABOUTME: Bytes are accepted only against a consumed one-time grant; views are owned by V02.

import { adaptD1, type SqlDatabase } from "@bfb/db";

import {
  assertNoAppCookie,
  corsHeaders,
  validateArtifactEnv,
  type ArtifactBindings,
} from "./env.js";
import { handleUpload } from "./upload.js";

export interface ArtifactFetchOptions {
  db?: SqlDatabase;
  now?: string;
}

export function createArtifactFetchHandler(options: ArtifactFetchOptions = {}) {
  return async function fetch(request: Request, env: ArtifactBindings): Promise<Response> {
    let validated;
    try {
      validated = validateArtifactEnv(env);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid_environment";
      return new Response(JSON.stringify({ ok: false, error: "config_invalid", message }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    const db = options.db ?? adaptD1(validated.db);
    const now = options.now ?? new Date().toISOString();

    try {
      assertNoAppCookie(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : "session_cookie_rejected";
      return new Response(JSON.stringify({ ok: false, error: "credential_confusion", message }), {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(request, validated.artifactOrigin),
        });
      }

      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        const headers = corsHeaders(request, validated.artifactOrigin);
        headers.set("content-type", "application/json; charset=utf-8");
        headers.set("cache-control", "no-store");
        // Never set Set-Cookie on the artifact origin.
        return new Response(
          JSON.stringify({
            ok: true,
            package: "F03",
            cookie_less: true,
            credentialed_cors: false,
            environment: validated.environment,
          }),
          { status: 200, headers },
        );
      }

      const upload = /^\/upload\/([^/]+)$/.exec(url.pathname);
      if (upload?.[1]) {
        return handleUpload(request, upload[1], {
          db,
          artifacts: validated.artifacts,
          now,
          abuseSecret: validated.uploadAbuseSecret,
        });
      }

      const headers = corsHeaders(request, validated.artifactOrigin);
      headers.set("content-type", "application/json; charset=utf-8");
      return new Response(
        JSON.stringify({
          ok: false,
          error: "artifact_not_implemented",
          message: "Artifact views are owned by V02",
        }),
        { status: 501, headers },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "artifact_request_failed";
      return new Response(
        JSON.stringify({ ok: false, error: "artifact_request_failed", message }),
        {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }
  };
}

export default {
  async fetch(request: Request, env: ArtifactBindings): Promise<Response> {
    return createArtifactFetchHandler()(request, env);
  },
};

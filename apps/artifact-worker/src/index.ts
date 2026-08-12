// ABOUTME: Serves the cookie-less Artifact Worker origin shell with private R2 binding only.
// ABOUTME: Upload/view grant behavior is owned by V01; this package keeps the origin inert.

import {
  assertNoAppCookie,
  corsHeaders,
  validateArtifactEnv,
  type ArtifactBindings,
} from "./env.js";

export default {
  async fetch(request: Request, env: ArtifactBindings): Promise<Response> {
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

      const headers = corsHeaders(request, validated.artifactOrigin);
      headers.set("content-type", "application/json; charset=utf-8");
      return new Response(
        JSON.stringify({
          ok: false,
          error: "artifact_not_implemented",
          message: "Artifact upload and view are owned by V01",
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
  },
};

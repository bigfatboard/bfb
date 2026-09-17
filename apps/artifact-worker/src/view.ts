// ABOUTME: Serves the fixed view bootstrap and redeems one-time view grants into bytes.
// ABOUTME: Redemption consumes the grant before R2 reads; responses carry the frozen header policy.

import { createHash } from "node:crypto";

import type { SqlDatabase } from "@bfb/db";
import {
  ARTIFACT_BODY_LIMIT,
  artifactSubject,
  consumeArtifactBudget,
  isUlid,
  redeemViewGrant,
} from "@bfb/domain";

import { artifactAbuseSeeds } from "./upload.js";
import { buildTextDocument, buildViewerFallback, isViewerTextFormat } from "./renderers.js";

export interface ViewDeps {
  db: SqlDatabase;
  artifacts: R2Bucket;
  now: string;
  abuseSecret: string;
  appOrigin: string;
}

/** Locked-down feature policy: redeemed documents need no privileged capability. */
export const VIEW_PERMISSIONS_POLICY = [
  "accelerometer=()",
  "camera=()",
  "display-capture=()",
  "fullscreen=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "picture-in-picture=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "sync-xhr=()",
  "usb=()",
  "web-share=()",
  "xr-spatial-tracking=()",
].join(", ");

/**
 * Final response policy for every redeemed document. The sandbox directive
 * intersects the iframe attribute and removes form capability; there is no
 * same-origin, network, top navigation, popup, download, or form grant.
 * Frame ancestors pin the exact app origin so the bytes cannot be framed
 * elsewhere. This policy also constrains a redeemed document opened top-level.
 */
export function viewFinalCsp(appOrigin: string): string {
  return [
    "default-src 'none'",
    "sandbox allow-scripts",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "connect-src 'none'",
    "font-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${appOrigin}`,
  ].join("; ");
}

/**
 * Bootstrap response policy. It deliberately carries no sandbox directive:
 * the iframe attribute owns `allow-scripts allow-forms` for the single
 * redemption submit, and a response sandbox here would intersect forms away
 * before redemption can run. The bootstrap still forbids network, framing
 * outside the app origin, and navigation targets other than its own redeem
 * endpoint.
 */
export function viewBootstrapCsp(appOrigin: string): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src 'none'",
    "connect-src 'none'",
    "font-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'self'",
    "base-uri 'none'",
    `frame-ancestors ${appOrigin}`,
  ].join("; ");
}

/**
 * Fixed bootstrap script. A sandboxed frame without `allow-same-origin` has
 * the opaque origin `null`, so the viewer cannot address it with a targeted
 * `postMessage`. Instead the bootstrap offers a fresh `MessageChannel` port
 * to its parent and accepts the grant exactly once over that port, then
 * submits the secret in a same-origin form POST that navigates the iframe to
 * the redeemed document. The parent post carries no authority — only a
 * ready signal and the port — so its wildcard target cannot leak a secret;
 * the secret crosses exactly one port whose peer the bootstrap created. The
 * view ID is read from the bootstrap location, so the served document is
 * byte-identical for every view and never contains artifact bytes or secrets.
 */
export const VIEW_BOOTSTRAP_SCRIPT = `(function () {
  "use strict";
  var consumed = false;
  function showHint(text) {
    var el = document.getElementById("bfb-view-status");
    if (el) el.textContent = text;
  }
  function validSecret(value) {
    return (
      typeof value === "string" &&
      value.length >= 16 &&
      value.length <= 256 &&
      /^[A-Za-z0-9_-]+$/.test(value)
    );
  }
  function validNonce(value) {
    return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
  }
  function viewIdFromPath() {
    var match = /^\\/view\\/([0-9A-HJKMNP-TV-Z]{26})\\/?$/.exec(location.pathname);
    return match ? match[1] : null;
  }
  var channel = new MessageChannel();
  channel.port1.onmessage = function (event) {
    if (consumed) return;
    var data = event.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    var keys = Object.keys(data);
    if (keys.length !== 3) return;
    if (data.type !== "bfb-view-grant") return;
    if (!validSecret(data.secret) || !validNonce(data.nonce)) return;
    var viewId = viewIdFromPath();
    if (!viewId) {
      showHint("Preview unavailable. Reload the preview to request a new grant.");
      return;
    }
    consumed = true;
    try {
      channel.port1.close();
    } catch (ignored) {}
    var form = document.createElement("form");
    form.method = "POST";
    form.action = "/view/" + viewId + "/redeem";
    var secret = document.createElement("input");
    secret.type = "hidden";
    secret.name = "view_secret";
    secret.value = data.secret;
    var nonce = document.createElement("input");
    nonce.type = "hidden";
    nonce.name = "view_nonce";
    nonce.value = data.nonce;
    form.appendChild(secret);
    form.appendChild(nonce);
    document.body.appendChild(form);
    form.submit();
  };
  try {
    window.parent.postMessage({ type: "bfb-view-ready" }, "*", [channel.port2]);
  } catch (ignored) {
    showHint("Preview unavailable. Reload the preview to request a new grant.");
  }
  window.setTimeout(function () {
    if (!consumed) {
      showHint("Waiting for the viewer grant. Reload the preview to request a new grant.");
    }
  }, 8000);
})();`;

/** Byte-identical bootstrap document for every view; it carries no bytes and no secret. */
export function buildViewBootstrap(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Artifact preview</title><style>body{font-family:system-ui,sans-serif;color:#0f172a;background:#fff;margin:0;padding:2rem;}</style></head><body><p id="bfb-view-status">Loading preview.</p><script>${VIEW_BOOTSTRAP_SCRIPT}</script></body></html>`;
}

function viewHeaders(contentType: string, csp: string): Headers {
  const headers = new Headers({
    "content-type": contentType,
    "content-security-policy": csp,
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "permissions-policy": VIEW_PERMISSIONS_POLICY,
  });
  return headers;
}

/** Serves GET /view/:viewId. The document is fixed; unknown IDs get the same bytes. */
export function handleViewBootstrap(
  request: Request,
  viewId: string,
  options: { appOrigin: string },
): Response {
  const headers = viewHeaders("text/html; charset=utf-8", viewBootstrapCsp(options.appOrigin));
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers,
    });
  }
  if (!isUlid(viewId)) {
    return new Response(
      JSON.stringify({ error: "request_rejected", message: "request rejected" }),
      {
        status: 403,
        headers,
      },
    );
  }
  // Never set Set-Cookie on the artifact origin; the bootstrap carries no bytes.
  return new Response(buildViewBootstrap(), { status: 200, headers });
}

async function readBoundedForm(request: Request, maximumBytes: number): Promise<URLSearchParams> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
      throw new Error("body_too_large");
    }
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new Error("body_too_large");
      }
      chunks.push(chunk.value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new URLSearchParams(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  );
}

const VIEW_CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpeg: "image/jpeg",
};

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Handles POST /view/:viewId/redeem. Consumes the one-time grant before any
 * R2 read; every credential failure is a uniform 403 that reveals nothing
 * about which field was wrong. Oversized bodies fail before bytes.
 */
export async function handleViewRedeem(
  request: Request,
  viewId: string,
  deps: ViewDeps,
): Promise<Response> {
  const headers = viewHeaders("application/json; charset=utf-8", viewFinalCsp(deps.appOrigin));
  const rejected = () =>
    new Response(JSON.stringify({ error: "request_rejected", message: "request rejected" }), {
      status: 403,
      headers,
    });
  try {
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "method_not_allowed" }), {
        status: 405,
        headers,
      });
    }
    if (!isUlid(viewId)) return rejected();
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.startsWith("application/x-www-form-urlencoded")) return rejected();
    let form: URLSearchParams;
    try {
      form = await readBoundedForm(request, ARTIFACT_BODY_LIMIT);
    } catch (error) {
      if (error instanceof Error && error.message === "body_too_large") {
        return new Response(JSON.stringify({ error: "body_too_large" }), {
          status: 413,
          headers,
        });
      }
      return rejected();
    }
    const keys = [...form.keys()].sort();
    if (keys.length !== 2 || keys[0] !== "view_nonce" || keys[1] !== "view_secret") {
      return rejected();
    }
    const secret = form.get("view_secret") ?? "";
    const nonce = form.get("view_nonce") ?? "";
    if (
      secret.length < 16 ||
      secret.length > 256 ||
      !/^[A-Za-z0-9_-]+$/.test(secret) ||
      !/^[0-9a-f]{32}$/.test(nonce)
    ) {
      return rejected();
    }

    const seeds = artifactAbuseSeeds(deps.abuseSecret, request);
    if (!seeds) return rejected();
    const budgeted = await consumeArtifactBudget(deps.db, {
      ...seeds,
      surface: "artifact:view-redeem",
      subject: artifactSubject(`view-redeem:${viewId}`),
      activity: "attempt",
      now: deps.now,
    });
    if (!budgeted) return rejected();

    // One conditional batch rechecks the nonce, expiry, version availability,
    // exact content hash, and the current authorization epoch, consumes the
    // grant, and inserts the audit row before any byte is read as an effect.
    let redeemed;
    try {
      redeemed = await deps.db.withTransaction((tx) =>
        redeemViewGrant(tx, { viewId, secret, nonce, now: deps.now }),
      );
    } catch {
      return rejected();
    }

    const expectedPrefix = `workspaces/${redeemed.workspaceId}/`;
    if (!redeemed.r2Key.startsWith(expectedPrefix)) {
      return new Response(JSON.stringify({ error: "view_failed" }), { status: 500, headers });
    }
    const object = await deps.artifacts.get(redeemed.r2Key);
    if (!object) {
      return new Response(JSON.stringify({ error: "view_failed" }), { status: 500, headers });
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    // R2 is not assumed immutable: re-verify the content hash before serving.
    if (sha256Hex(bytes) !== redeemed.contentHash) {
      return new Response(JSON.stringify({ error: "view_failed" }), { status: 500, headers });
    }

    if (isViewerTextFormat(redeemed.format)) {
      let source: string;
      try {
        source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        return textResponse(buildViewerFallback("unsupported"), deps.appOrigin);
      }
      return textResponse(buildTextDocument(redeemed.format, source), deps.appOrigin);
    }
    const binaryType = VIEW_CONTENT_TYPES[redeemed.format];
    if (!binaryType) {
      return new Response(JSON.stringify({ error: "view_failed" }), { status: 500, headers });
    }
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: viewHeaders(binaryType, viewFinalCsp(deps.appOrigin)),
    });
  } catch {
    // Never echo the secret, nonce, digests, or bytes in an error response.
    return rejected();
  }
}

function textResponse(document: string, appOrigin: string): Response {
  return new Response(document, {
    status: 200,
    headers: viewHeaders("text/html; charset=utf-8", viewFinalCsp(appOrigin)),
  });
}

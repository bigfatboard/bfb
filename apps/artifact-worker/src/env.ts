// ABOUTME: Validates Artifact Worker bindings and cookie-less origin separation.
// ABOUTME: Rejects credentialed CORS and missing private R2 or origin configuration.

export interface ArtifactBindings {
  ARTIFACTS: R2Bucket;
  DB: D1Database;
  ARTIFACT_ORIGIN: string;
  APP_ORIGIN: string;
  ENVIRONMENT: string;
  UPLOAD_ABUSE_SECRET?: string;
}

export interface ValidatedArtifactEnv {
  artifacts: R2Bucket;
  db: D1Database;
  artifactOrigin: string;
  appOrigin: string;
  environment: "local" | "staging" | "production";
  uploadAbuseSecret: string;
}

function requireBinding<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null) {
    throw new Error("missing binding: " + name);
  }
  return value;
}

function parseOrigin(raw: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid origin: " + name);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("invalid origin protocol: " + name);
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("origin must be scheme+host only: " + name);
  }
  return url;
}

export function validateArtifactEnv(env: Partial<ArtifactBindings>): ValidatedArtifactEnv {
  const ARTIFACTS = requireBinding(env.ARTIFACTS, "ARTIFACTS");
  const DB = requireBinding(env.DB, "DB");
  const ARTIFACT_ORIGIN = requireBinding(env.ARTIFACT_ORIGIN, "ARTIFACT_ORIGIN");
  const APP_ORIGIN = requireBinding(env.APP_ORIGIN, "APP_ORIGIN");
  const ENVIRONMENT = requireBinding(env.ENVIRONMENT, "ENVIRONMENT");
  if (ENVIRONMENT !== "local" && ENVIRONMENT !== "staging" && ENVIRONMENT !== "production") {
    throw new Error("invalid environment: " + ENVIRONMENT);
  }
  const artifact = parseOrigin(ARTIFACT_ORIGIN, "ARTIFACT_ORIGIN");
  const app = parseOrigin(APP_ORIGIN, "APP_ORIGIN");
  if (artifact.hostname === app.hostname) {
    throw new Error("artifact hostname must differ from app hostname");
  }
  if (ENVIRONMENT !== "local" && (artifact.protocol !== "https:" || app.protocol !== "https:")) {
    throw new Error("staging and production origins must use https");
  }
  return {
    artifacts: ARTIFACTS,
    db: DB,
    artifactOrigin: artifact.origin,
    appOrigin: app.origin,
    environment: ENVIRONMENT,
    // Staging/production set this with `wrangler secret put UPLOAD_ABUSE_SECRET`.
    // Uploads fail closed while it is missing or short.
    uploadAbuseSecret: typeof env.UPLOAD_ABUSE_SECRET === "string" ? env.UPLOAD_ABUSE_SECRET : "",
  };
}

export function assertNoAppCookie(request: Request): void {
  const cookie = request.headers.get("cookie");
  if (
    cookie &&
    (/(?:^|;\s*)__Host-bfb_session=/i.test(cookie) || /(?:^|;\s*)bfb[_-]?session=/i.test(cookie))
  ) {
    throw new Error("app session cookie is not accepted on artifact origin");
  }
}

export function corsHeaders(request: Request, artifactOrigin: string): Headers {
  const headers = new Headers();
  const origin = request.headers.get("origin");
  // Non-credentialed only. Never reflect arbitrary origins with credentials.
  if (origin === artifactOrigin) {
    headers.set("access-control-allow-origin", artifactOrigin);
    headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
    headers.set("access-control-max-age", "600");
    headers.set("vary", "origin");
  }
  return headers;
}

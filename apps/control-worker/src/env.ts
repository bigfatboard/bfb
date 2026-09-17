// ABOUTME: Validates Control Worker bindings and canonical host configuration before serving.
// ABOUTME: Missing D1, R2, Queue, DO, origin, or jurisdiction configuration fails closed.

export type Jurisdiction = "eu" | "us" | "global";

export interface ControlOrigins {
  appOrigin: string;
  artifactOrigin: string;
  launchOrigin: string;
  appHostname: string;
  artifactHostname: string;
  launchHostname: string;
}

export interface ControlBindings {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  ASSETS: Fetcher;
  JOBS: Queue;
  JOBS_DLQ: Queue;
  NOTIFY_JOBS?: Queue | undefined;
  NOTIFY_DLQ?: Queue | undefined;
  VAPID_PUBLIC_KEY?: string | undefined;
  VAPID_PRIVATE_KEY?: string | undefined;
  VAPID_SUBJECT?: string | undefined;
  WORKSPACE_HUB: DurableObjectNamespace;
  APP_ORIGIN: string;
  ARTIFACT_ORIGIN: string;
  LAUNCH_ORIGIN: string;
  JURISDICTION: string;
  ENVIRONMENT: string;
  BETTER_AUTH_SECRETS?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  AUTH_ABUSE_SECRET?: string;
}

export interface ValidatedControlEnv {
  bindings: ControlBindings;
  origins: ControlOrigins;
  jurisdiction: Jurisdiction;
  environment: "local" | "staging" | "production";
}

const workerFirstPrefixes = [
  "/api/",
  "/auth/",
  "/mcp",
  "/oauth/",
  "/realtime/",
  "/runner/",
  "/webhooks/",
  "/.well-known/",
] as const;

export const WORKER_FIRST_ROUTE_PREFIXES = workerFirstPrefixes;

/**
 * Wrangler `assets.run_worker_first` globs that must cover every worker-first
 * prefix so SPA fallback cannot shadow OAuth, API, MCP, or auth routes.
 */
export const RUN_WORKER_FIRST_GLOBS = [
  "/api",
  "/api/*",
  "/auth",
  "/auth/*",
  "/mcp",
  "/mcp/*",
  "/oauth",
  "/oauth/*",
  "/realtime",
  "/realtime/*",
  "/runner",
  "/runner/*",
  "/webhooks",
  "/webhooks/*",
  "/.well-known",
  "/.well-known/*",
  "/healthz",
] as const;

export function workspaceNamespaceForJurisdiction(
  namespace: DurableObjectNamespace,
  jurisdiction: Jurisdiction,
): DurableObjectNamespace {
  return jurisdiction === "global" ? namespace : namespace.jurisdiction(jurisdiction);
}

export function isWorkerFirstPath(pathname: string): boolean {
  if (pathname === "/mcp") {
    return true;
  }
  return workerFirstPrefixes.some((prefix) => {
    if (prefix.endsWith("/")) {
      return pathname === prefix.slice(0, -1) || pathname.startsWith(prefix);
    }
    return pathname === prefix || pathname.startsWith(prefix + "/");
  });
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

function parseJurisdiction(value: string): Jurisdiction {
  if (value === "eu" || value === "us" || value === "global") {
    return value;
  }
  throw new Error("invalid jurisdiction: " + value);
}

function parseEnvironment(value: string): "local" | "staging" | "production" {
  if (value === "local" || value === "staging" || value === "production") {
    return value;
  }
  throw new Error("invalid environment: " + value);
}

export function validateControlEnv(env: Partial<ControlBindings>): ValidatedControlEnv {
  const DB = requireBinding(env.DB, "DB");
  const ARTIFACTS = requireBinding(env.ARTIFACTS, "ARTIFACTS");
  const ASSETS = requireBinding(env.ASSETS, "ASSETS");
  const JOBS = requireBinding(env.JOBS, "JOBS");
  const JOBS_DLQ = requireBinding(env.JOBS_DLQ, "JOBS_DLQ");
  const WORKSPACE_HUB = requireBinding(env.WORKSPACE_HUB, "WORKSPACE_HUB");
  const APP_ORIGIN = requireBinding(env.APP_ORIGIN, "APP_ORIGIN");
  const ARTIFACT_ORIGIN = requireBinding(env.ARTIFACT_ORIGIN, "ARTIFACT_ORIGIN");
  const LAUNCH_ORIGIN = requireBinding(env.LAUNCH_ORIGIN, "LAUNCH_ORIGIN");
  const JURISDICTION = requireBinding(env.JURISDICTION, "JURISDICTION");
  const ENVIRONMENT = requireBinding(env.ENVIRONMENT, "ENVIRONMENT");

  const app = parseOrigin(APP_ORIGIN, "APP_ORIGIN");
  const artifact = parseOrigin(ARTIFACT_ORIGIN, "ARTIFACT_ORIGIN");
  const launch = parseOrigin(LAUNCH_ORIGIN, "LAUNCH_ORIGIN");
  const environment = parseEnvironment(ENVIRONMENT);

  if (app.hostname === artifact.hostname) {
    throw new Error("artifact hostname must differ from app hostname");
  }
  if (app.hostname === launch.hostname) {
    throw new Error("launch hostname must differ from app hostname");
  }
  if (artifact.hostname === launch.hostname) {
    throw new Error("launch hostname must differ from artifact hostname");
  }
  if (
    environment !== "local" &&
    (app.protocol !== "https:" || artifact.protocol !== "https:" || launch.protocol !== "https:")
  ) {
    throw new Error("staging and production origins must use https");
  }

  return {
    bindings: {
      DB,
      ARTIFACTS,
      ASSETS,
      JOBS,
      JOBS_DLQ,
      NOTIFY_JOBS: env.NOTIFY_JOBS,
      NOTIFY_DLQ: env.NOTIFY_DLQ,
      VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY,
      VAPID_SUBJECT: env.VAPID_SUBJECT,
      WORKSPACE_HUB,
      APP_ORIGIN: app.origin,
      ARTIFACT_ORIGIN: artifact.origin,
      LAUNCH_ORIGIN: launch.origin,
      JURISDICTION,
      ENVIRONMENT,
    },
    origins: {
      appOrigin: app.origin,
      artifactOrigin: artifact.origin,
      launchOrigin: launch.origin,
      appHostname: app.hostname,
      artifactHostname: artifact.hostname,
      launchHostname: launch.hostname,
    },
    jurisdiction: parseJurisdiction(JURISDICTION),
    environment,
  };
}

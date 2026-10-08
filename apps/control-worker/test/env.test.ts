// ABOUTME: Verifies Control Worker environment validation and worker-first path ownership.
// ABOUTME: Drives the real validateControlEnv and isWorkerFirstPath implementations.

import { describe, expect, it, vi } from "vitest";
import { FIX, seedSyntheticWorkspace } from "@bfb/domain";

import { createFetchHandler } from "../src/index.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { AUTH_TEST_ENV, openAuthTestContext, seedAuthSession } from "./auth-helpers.js";

import {
  isWorkerFirstPath,
  validateControlEnv,
  workspaceNamespaceForJurisdiction,
  type ControlBindings,
} from "../src/env.js";

function fakeBinding<T extends object>(label: string): T {
  return { __synthetic: label } as unknown as T;
}

function validEnv(overrides: Partial<ControlBindings> = {}): ControlBindings {
  return {
    DB: fakeBinding<D1Database>("db"),
    ARTIFACTS: fakeBinding<R2Bucket>("r2"),
    ASSETS: fakeBinding<Fetcher>("assets"),
    JOBS: fakeBinding<Queue>("jobs"),
    JOBS_DLQ: fakeBinding<Queue>("dlq"),
    WORKSPACE_HUB: fakeBinding<DurableObjectNamespace>("hub"),
    APP_ORIGIN: "https://bfb.example.test",
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
    ...overrides,
  };
}

describe("validateControlEnv", () => {
  it("keeps uncertified features disabled in every environment unless explicitly enabled", () => {
    for (const ENVIRONMENT of ["local", "staging", "production"] as const) {
      expect(validateControlEnv(validEnv({ ENVIRONMENT })).features).toEqual({
        artifactViewer: false,
        artifactReview: false,
        discussions: false,
      });
    }
    expect(
      validateControlEnv(
        validEnv({
          ARTIFACT_VIEWER_ENABLED: "true",
          ARTIFACT_REVIEW_ENABLED: "false",
          DISCUSSIONS_ENABLED: "true",
        }),
      ).features,
    ).toEqual({ artifactViewer: true, artifactReview: false, discussions: true });
  });

  it.each(["ARTIFACT_VIEWER_ENABLED", "ARTIFACT_REVIEW_ENABLED", "DISCUSSIONS_ENABLED"] as const)(
    "rejects malformed %s instead of enabling it",
    (name) => {
      for (const value of ["TRUE", "1", "", " true "]) {
        expect(() => validateControlEnv(validEnv({ [name]: value }))).toThrow(
          `invalid boolean: ${name}`,
        );
      }
    },
  );

  it("accepts a complete local environment", () => {
    const validated = validateControlEnv(validEnv());
    expect(validated.environment).toBe("local");
    expect(validated.jurisdiction).toBe("eu");
    expect(validated.origins.appHostname).toBe("bfb.example.test");
  });

  it("fails closed when D1 is missing", () => {
    const env = validEnv();
    delete (env as { DB?: D1Database }).DB;
    expect(() => validateControlEnv(env)).toThrow(/missing binding: DB/);
  });

  it("fails closed when R2 is missing", () => {
    const env = validEnv();
    delete (env as { ARTIFACTS?: R2Bucket }).ARTIFACTS;
    expect(() => validateControlEnv(env)).toThrow(/missing binding: ARTIFACTS/);
  });

  it("fails closed when Static Assets is missing", () => {
    const env = validEnv();
    delete (env as { ASSETS?: Fetcher }).ASSETS;
    expect(() => validateControlEnv(env)).toThrow(/missing binding: ASSETS/);
  });

  it("fails closed when Queue is missing", () => {
    const env = validEnv();
    delete (env as { JOBS?: Queue }).JOBS;
    expect(() => validateControlEnv(env)).toThrow(/missing binding: JOBS/);
  });

  it("fails closed when the dead-letter Queue is missing", () => {
    const env = validEnv();
    delete (env as { JOBS_DLQ?: Queue }).JOBS_DLQ;
    expect(() => validateControlEnv(env)).toThrow(/missing binding: JOBS_DLQ/);
  });

  it("fails closed when Durable Object binding is missing", () => {
    const env = validEnv();
    delete (env as { WORKSPACE_HUB?: DurableObjectNamespace }).WORKSPACE_HUB;
    expect(() => validateControlEnv(env)).toThrow(/missing binding: WORKSPACE_HUB/);
  });

  it("fails when artifact and app share a hostname even on different ports", () => {
    expect(() =>
      validateControlEnv(
        validEnv({
          ARTIFACT_ORIGIN: "https://bfb.example.test:9443",
        }),
      ),
    ).toThrow(/artifact hostname must differ/);
  });

  it("requires pairwise distinct artifact and launch hostnames", () => {
    expect(() =>
      validateControlEnv(
        validEnv({
          LAUNCH_ORIGIN: "https://artifacts.bfb.example.test:9443",
        }),
      ),
    ).toThrow(/launch hostname must differ from artifact hostname/);
  });

  it("requires HTTPS outside local development", () => {
    expect(() =>
      validateControlEnv(
        validEnv({
          ENVIRONMENT: "staging",
          APP_ORIGIN: "http://bfb.staging.example.test",
        }),
      ),
    ).toThrow(/must use https/);
  });

  it("fails on invalid jurisdiction", () => {
    expect(() => validateControlEnv(validEnv({ JURISDICTION: "mars" }))).toThrow(
      /invalid jurisdiction/,
    );
  });
});

describe("isWorkerFirstPath", () => {
  it("protects API auth MCP OAuth realtime runner webhook and discovery paths", () => {
    expect(isWorkerFirstPath("/api/v1/tasks")).toBe(true);
    expect(isWorkerFirstPath("/auth/sign-in")).toBe(true);
    expect(isWorkerFirstPath("/mcp")).toBe(true);
    expect(isWorkerFirstPath("/oauth")).toBe(true);
    expect(isWorkerFirstPath("/oauth/authorize")).toBe(true);
    expect(isWorkerFirstPath("/oauth/token")).toBe(true);
    expect(isWorkerFirstPath("/realtime/workspaces/x")).toBe(true);
    expect(isWorkerFirstPath("/runner/connect")).toBe(true);
    expect(isWorkerFirstPath("/webhooks/github")).toBe(true);
    expect(isWorkerFirstPath("/.well-known/oauth-authorization-server")).toBe(true);
  });

  it("leaves SPA paths to assets", () => {
    expect(isWorkerFirstPath("/")).toBe(false);
    expect(isWorkerFirstPath("/w/demo")).toBe(false);
    expect(isWorkerFirstPath("/settings")).toBe(false);
  });
});

describe("workspaceNamespaceForJurisdiction", () => {
  it("forwards the normalized namespace through the production fetch entrypoint", async () => {
    const now = "2026-08-07T12:00:00.000Z";
    const context = openAuthTestContext(now);
    try {
      await seedSyntheticWorkspace(context.db);
      const session = await seedAuthSession(context, { humanId: FIX.owner, now });
      const lane = createTestWorkspaceHubNamespace(context.db);
      const addressedNames: string[] = [];
      const namespace = {
        idFromName: lane.idFromName.bind(lane),
        get(id: DurableObjectId) {
          addressedNames.push(id.toString());
          return {
            async fetch(input: RequestInfo | URL, init?: RequestInit) {
              const body = JSON.parse(String(init?.body)) as { request: { workspaceId: string } };
              return lane.get(lane.idFromName(body.request.workspaceId)).fetch(input, init);
            },
          };
        },
        jurisdiction() {
          throw new Error("Jurisdiction restrictions are not implemented in workerd.");
        },
      } as unknown as DurableObjectNamespace;
      const bindings = validEnv({
        WORKSPACE_HUB: namespace,
        APP_ORIGIN: AUTH_TEST_ENV.APP_ORIGIN,
        LOCAL_HUB_JURISDICTION_EMULATION: "true",
      });
      const handler = createFetchHandler({
        db: context.db,
        authDatabase: context.raw,
        authEnv: AUTH_TEST_ENV,
        now,
      });
      const signedIn = await handler(
        new Request(`${AUTH_TEST_ENV.APP_ORIGIN}/auth/session`, {
          headers: { cookie: session.cookie },
        }),
        bindings,
      );
      expect(signedIn.status).toBe(200);
      const csrf = ((await signedIn.json()) as { csrf_token: string }).csrf_token;
      const response = await handler(
        new Request(`${AUTH_TEST_ENV.APP_ORIGIN}/api/v1/workspaces/${FIX.workspace}/projects`, {
          method: "POST",
          headers: {
            cookie: session.cookie,
            origin: AUTH_TEST_ENV.APP_ORIGIN,
            "sec-fetch-site": "same-origin",
            "x-bfb-csrf": csrf,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            request_id: "pilot-entrypoint-project",
            name: "Synthetic local project",
            slug: "pilot-entrypoint",
            tint: "#336699",
            access_mode: "restricted",
            repository_host: "github.com",
            hosted_repository_id: "synthetic-pilot-entrypoint",
            repository_subpath: ".",
          }),
        }),
        bindings,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        replayed: false,
        result: { slug: "pilot-entrypoint" },
      });
      expect(addressedNames).toEqual([JSON.stringify(["bfb-local-hub", "eu", FIX.workspace])]);
    } finally {
      context.raw.close();
    }
  });

  it("keeps native jurisdiction routing strict when emulation is absent or false", () => {
    const namespace = fakeBinding<DurableObjectNamespace>("native-hub");
    Object.assign(namespace, {
      jurisdiction() {
        throw new Error("Jurisdiction restrictions are not implemented in workerd.");
      },
    });
    for (const setting of [undefined, "false"]) {
      const validated = validateControlEnv(
        validEnv({ WORKSPACE_HUB: namespace, LOCAL_HUB_JURISDICTION_EMULATION: setting }),
      );
      expect(validated.bindings.WORKSPACE_HUB).toBe(namespace);
      expect(() =>
        workspaceNamespaceForJurisdiction(validated.bindings.WORKSPACE_HUB, "eu"),
      ).toThrow("Jurisdiction restrictions are not implemented in workerd.");
    }
  });

  it("rejects malformed settings and emulation in staging or production", () => {
    for (const setting of ["TRUE", "1", "", " true "])
      expect(() =>
        validateControlEnv(validEnv({ LOCAL_HUB_JURISDICTION_EMULATION: setting })),
      ).toThrow("invalid boolean: LOCAL_HUB_JURISDICTION_EMULATION");
    for (const ENVIRONMENT of ["staging", "production"])
      expect(() =>
        validateControlEnv(
          validEnv({
            ENVIRONMENT,
            LOCAL_HUB_JURISDICTION_EMULATION: "true",
          }),
        ),
      ).toThrow("local Hub jurisdiction emulation requires ENVIRONMENT=local");
  });

  it("uses real named DO methods with distinct deterministic local scope and native receivers", () => {
    const namespace = fakeBinding<DurableObjectNamespace>("native-hub");
    Object.assign(namespace, {
      idFromName(this: DurableObjectNamespace, name: string) {
        expect(this).toBe(namespace);
        return { toString: () => name } as DurableObjectId;
      },
      get(this: DurableObjectNamespace, id: DurableObjectId) {
        expect(this).toBe(namespace);
        return { id } as DurableObjectStub;
      },
      jurisdiction: vi.fn(() => {
        throw new Error("native jurisdiction is unavailable");
      }),
    });
    const normalized = validateControlEnv(
      validEnv({
        WORKSPACE_HUB: namespace,
        LOCAL_HUB_JURISDICTION_EMULATION: "true",
      }),
    ).bindings.WORKSPACE_HUB;
    const eu = workspaceNamespaceForJurisdiction(normalized, "eu");
    const us = workspaceNamespaceForJurisdiction(normalized, "us");
    const global = workspaceNamespaceForJurisdiction(normalized, "global");
    const euId = eu.idFromName("same-workspace");
    const usId = us.idFromName("same-workspace");
    const globalId = global.idFromName("same-workspace");
    expect(new Set([String(euId), String(usId), String(globalId)]).size).toBe(3);
    expect(String(globalId)).toBe("same-workspace");
    expect(eu.get(euId).id).toBe(euId);
    expect(eu.getByName("same-workspace").id.toString()).toBe(String(euId));
    expect(() => eu.get(usId)).toThrow("local Hub ID scope mismatch");
    expect(() => eu.get(globalId)).toThrow("local Hub ID scope mismatch");
    expect(() => eu.idFromString(String(euId))).toThrow("requires a named workspace ID");
    expect(() => eu.newUniqueId()).toThrow("requires a named workspace ID");
    expect(() => normalized.jurisdiction("mars" as "eu")).toThrow(
      "unsupported local Hub jurisdiction",
    );
    expect(namespace.jurisdiction).not.toHaveBeenCalled();
    const restarted = validateControlEnv(
      validEnv({
        WORKSPACE_HUB: namespace,
        LOCAL_HUB_JURISDICTION_EMULATION: "true",
      }),
    ).bindings.WORKSPACE_HUB;
    expect(
      String(workspaceNamespaceForJurisdiction(restarted, "eu").idFromName("same-workspace")),
    ).toBe(String(euId));
  });

  it("selects EU placement and leaves global placement unscoped", () => {
    const namespace = fakeBinding<DurableObjectNamespace>("hub");
    const euNamespace = fakeBinding<DurableObjectNamespace>("eu-hub");
    const jurisdiction = vi.fn(() => euNamespace);
    Object.assign(namespace, { jurisdiction });

    expect(workspaceNamespaceForJurisdiction(namespace, "eu")).toBe(euNamespace);
    expect(jurisdiction).toHaveBeenCalledWith("eu");

    jurisdiction.mockClear();
    expect(workspaceNamespaceForJurisdiction(namespace, "global")).toBe(namespace);
    expect(jurisdiction).not.toHaveBeenCalled();
  });
});

// ABOUTME: Checks first-run identity routing and the browser's real passkey registration request shapes.
// ABOUTME: Refuses unsafe redirects, duplicate flow IDs, and unconfirmed authenticator outcomes.

import { afterEach, describe, expect, it, vi } from "vitest";
import { enrollmentFlow, githubReauthenticationURL } from "../src/auth/onboarding.js";
import { registerPasskey } from "../src/auth/webauthn.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const flow = "01K00000000000000000000009";

describe("real first-run browser boundary", () => {
  it("accepts only a single opaque flow identifier", () => {
    expect(enrollmentFlow(`?workspace_bootstrap=${flow}`, "workspace_bootstrap")).toBe(flow);
    for (const query of [
      "",
      "?workspace_bootstrap=../private",
      `?workspace_bootstrap=${flow}&workspace_bootstrap=${flow}`,
    ]) {
      expect(enrollmentFlow(query, "workspace_bootstrap")).toBeNull();
    }
  });

  it("refuses redirects outside the real GitHub verification origin", () => {
    expect(
      githubReauthenticationURL("https://github.com/login/oauth/authorize?client_id=public-id"),
    ).toContain("https://github.com/");
    for (const value of [
      undefined,
      "http://github.com/",
      "https://github.com:8443/",
      "https://github.com.evil.test/",
      "https://user@github.com/",
      "javascript:alert(1)",
    ]) {
      expect(() => githubReauthenticationURL(value)).toThrow();
    }
  });

  function authenticator(cancel = false) {
    const create = vi.fn(async (_options: CredentialCreationOptions) =>
      cancel
        ? null
        : {
            id: "credential",
            rawId: Uint8Array.of(1, 2).buffer,
            type: "public-key",
            authenticatorAttachment: "platform",
            getClientExtensionResults: () => ({}),
            response: {
              clientDataJSON: Uint8Array.of(3).buffer,
              attestationObject: Uint8Array.of(4).buffer,
              getTransports: () => ["internal"],
            },
          },
    );
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("navigator", { credentials: { create } });
    return create;
  }

  it("uses the registration ceremony, binary options and CSRF, then requires server confirmation", async () => {
    const create = authenticator();
    const calls: { url: unknown; init: RequestInit | undefined }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url, init });
      return Response.json(
        url === "/auth/passkeys/enroll/options"
          ? {
              options: {
                challenge: "AQI",
                rp: { name: "BFB", id: "localhost" },
                user: { id: "Aw", name: "owner", displayName: "Owner" },
                pubKeyCredParams: [{ type: "public-key", alg: -7 }],
                excludeCredentials: [{ type: "public-key", id: "BA" }],
              },
            }
          : { passkey: { id: flow } },
      );
    };
    await registerPasskey(fetchImpl, "csrf-one", flow, "This Mac");
    expect(calls.map((call) => call.url)).toEqual([
      "/auth/passkeys/enroll/options",
      "/auth/passkeys/enroll/verify",
    ]);
    expect(
      calls.every((call) => new Headers(call.init?.headers).get("x-bfb-csrf") === "csrf-one"),
    ).toBe(true);
    const options = create.mock.calls[0]?.[0] as unknown as CredentialCreationOptions;
    expect(new Uint8Array(options.publicKey!.challenge as ArrayBuffer)).toEqual(
      Uint8Array.of(1, 2),
    );
    expect(new Uint8Array(options.publicKey!.user.id as ArrayBuffer)).toEqual(Uint8Array.of(3));
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      flow_id: flow,
      response: {
        id: "credential",
        rawId: "AQI",
        type: "public-key",
        authenticatorAttachment: "platform",
        clientExtensionResults: {},
        response: { clientDataJSON: "Aw", attestationObject: "BA", transports: ["internal"] },
      },
    });
  });

  it("never sends a verify request if the browser cancels", async () => {
    authenticator(true);
    const fetchImpl = vi.fn(async () =>
      Response.json({
        options: {
          challenge: "AQ",
          rp: { name: "BFB" },
          user: { id: "Ag", name: "owner", displayName: "Owner" },
          pubKeyCredParams: [],
        },
      }),
    );
    await expect(registerPasskey(fetchImpl, "csrf", flow, "Mac")).rejects.toThrow("cancelled");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not report local credential creation as successful registration", async () => {
    authenticator();
    for (const result of [
      Response.json({ error: "request_rejected" }, { status: 403 }),
      Response.json({}),
    ]) {
      const fetchImpl: typeof fetch = async (url) =>
        url === "/auth/passkeys/enroll/options"
          ? Response.json({
              options: {
                challenge: "AQ",
                rp: { name: "BFB" },
                user: { id: "Ag", name: "owner", displayName: "Owner" },
                pubKeyCredParams: [],
              },
            })
          : result;
      await expect(registerPasskey(fetchImpl, "csrf", flow, "Mac")).rejects.toThrow();
    }
  });
});

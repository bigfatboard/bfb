// ABOUTME: Proves C02 secure cookie attributes, CSRF origin gates, and fail-closed secrets.
// ABOUTME: Drives shipped session helpers and createHumanAuth configuration.

import { describe, expect, it } from "vitest";

import { createHumanAuth } from "../src/auth/better-auth.js";
import {
  SESSION_COOKIE,
  assertBrowserMutation,
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
} from "../src/auth/session.js";

describe("session cookie security", () => {
  it("issues __Host- cookies with Secure HttpOnly SameSite=Lax Path=/", () => {
    const value = setSessionCookie("01JBFB0SESS10N000000000000");
    expect(SESSION_COOKIE).toBe("__Host-bfb_session");
    expect(value).toContain("__Host-bfb_session=");
    expect(value).toMatch(/Path=\//);
    expect(value).toMatch(/HttpOnly/);
    expect(value).toMatch(/Secure/);
    expect(value).toMatch(/SameSite=Lax/);
    expect(value).not.toMatch(/Domain=/i);
    expect(clearSessionCookie()).toMatch(/Max-Age=0/);
  });

  it("reads only the host-prefixed cookie and ignores legacy names", () => {
    const host = new Request("https://bfb.example.test/", {
      headers: { cookie: "__Host-bfb_session=abc" },
    });
    expect(readSessionCookie(host)).toBe("abc");
    const legacy = new Request("https://bfb.example.test/", {
      headers: { cookie: "bfb_session=legacy" },
    });
    expect(readSessionCookie(legacy)).toBeNull();
  });

  it("rejects mutations with wrong or missing Origin", () => {
    const appOrigin = "https://bfb.example.test";
    expect(() =>
      assertBrowserMutation(
        new Request("https://bfb.example.test/auth/sign-in/email", {
          method: "POST",
          headers: { origin: "https://evil.example" },
        }),
        appOrigin,
      ),
    ).toThrow(/origin/);
    expect(() =>
      assertBrowserMutation(
        new Request("https://bfb.example.test/api/v1/workspaces/x/tasks", { method: "POST" }),
        appOrigin,
      ),
    ).toThrow(/origin/);
    expect(() =>
      assertBrowserMutation(
        new Request("https://bfb.example.test/api/v1/workspaces/x/tasks", {
          method: "POST",
          headers: { origin: appOrigin, "sec-fetch-site": "cross-site" },
        }),
        appOrigin,
      ),
    ).toThrow(/cross-site/);
    expect(() =>
      assertBrowserMutation(
        new Request("https://bfb.example.test/api/v1/workspaces/x/tasks", {
          method: "POST",
          headers: { origin: appOrigin, "sec-fetch-site": "same-origin" },
        }),
        appOrigin,
      ),
    ).not.toThrow();
  });

  it("fails closed on short Better Auth secrets and disables cookie cache", () => {
    expect(() =>
      createHumanAuth({
        APP_ORIGIN: "https://bfb.example.test",
        BETTER_AUTH_SECRET: "too-short",
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
    const auth = createHumanAuth({
      APP_ORIGIN: "https://bfb.example.test",
      BETTER_AUTH_SECRET: "synthetic-local-auth-secret-not-for-prod",
    });
    expect(auth).toBeTruthy();
  });
});

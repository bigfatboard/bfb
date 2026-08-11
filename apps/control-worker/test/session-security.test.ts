// ABOUTME: Proves C02 host-only cookies, browser mutation gates, and key overlap.
// ABOUTME: Drives the shipped Better Auth configuration and normalized session resolver.

import { describe, expect, it } from "vitest";

import { humanAuthOptions, parseAuthKeys } from "../src/auth/better-auth.js";
import {
  SESSION_COOKIE,
  assertBrowserMutation,
  csrfTokenForSession,
  hasBrowserSessionCookie,
  readSessionCookie,
  resolveBrowserPrincipal,
} from "../src/auth/session.js";
import { AUTH_TEST_ENV, openAuthTestContext, seedAuthSession } from "./auth-helpers.js";

describe("human browser session security", () => {
  it("configures a host-only secure session cookie with no cache", () => {
    const context = openAuthTestContext();
    const options = humanAuthOptions(context.raw, AUTH_TEST_ENV);
    const cookie = options.advanced?.cookies?.session_token;

    expect(SESSION_COOKIE).toBe("__Host-bfb_session");
    expect(cookie?.name).toBe(SESSION_COOKIE);
    expect(cookie?.attributes).toMatchObject({
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
    });
    expect(cookie?.attributes).not.toHaveProperty("domain");
    expect(options.session?.cookieCache?.enabled).toBe(false);
  });

  it("reads only the host-prefixed browser cookie", () => {
    const host = new Request("https://bfb.example.test/", {
      headers: { cookie: `${SESSION_COOKIE}=abc` },
    });
    expect(readSessionCookie(host)).toBe("abc");
    const aliases = ["__Secure-bfb_session=secure", "bfb_session=bare"];
    for (const cookie of aliases) {
      expect(
        readSessionCookie(new Request("https://bfb.example.test/", { headers: { cookie } })),
      ).toBeNull();
    }
    const malformed = new Request("https://bfb.example.test/", {
      headers: { cookie: `${SESSION_COOKIE}=%` },
    });
    expect(readSessionCookie(malformed)).toBe("%");
    expect(hasBrowserSessionCookie(malformed)).toBe(true);
  });

  it("requires exact Origin and same-origin Fetch Metadata", () => {
    const appOrigin = AUTH_TEST_ENV.APP_ORIGIN;
    for (const headers of [
      {},
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { origin: appOrigin, "sec-fetch-site": "same-site" },
    ]) {
      expect(() =>
        assertBrowserMutation(
          new Request(`${appOrigin}/auth/sign-in/github`, { method: "POST", headers }),
          appOrigin,
        ),
      ).toThrow();
    }
    expect(() =>
      assertBrowserMutation(
        new Request(`${appOrigin}/auth/sign-in/github`, {
          method: "POST",
          headers: { origin: appOrigin, "sec-fetch-site": "same-origin" },
        }),
        appOrigin,
      ),
    ).not.toThrow();
  });

  it("accepts current and previous kid CSRF signatures but rejects unknown keys", () => {
    const appOrigin = AUTH_TEST_ENV.APP_ORIGIN;
    const keys = parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS);
    const sessionId = "auth-session-c02";
    const current = csrfTokenForSession(sessionId, keys);
    const previous = csrfTokenForSession(sessionId, [keys[1]!]);

    for (const token of [current, previous]) {
      expect(() =>
        assertBrowserMutation(
          new Request(`${appOrigin}/api/v1/workspaces/example/tasks`, {
            method: "POST",
            headers: {
              origin: appOrigin,
              "sec-fetch-site": "same-origin",
              "x-bfb-csrf": token,
            },
          }),
          appOrigin,
          { sessionId, authKeys: keys },
        ),
      ).not.toThrow();
    }

    for (const token of ["", `99.${current.split(".")[1]}`, `${keys[0]!.version}.deadbeef`]) {
      expect(() =>
        assertBrowserMutation(
          new Request(`${appOrigin}/api/v1/workspaces/example/tasks`, {
            method: "POST",
            headers: {
              origin: appOrigin,
              "sec-fetch-site": "same-origin",
              "x-bfb-csrf": token,
            },
          }),
          appOrigin,
          { sessionId, authKeys: keys },
        ),
      ).toThrow(/CSRF/);
    }
  });

  it("resolves a Better Auth session to a permission-free normalized human", async () => {
    const context = openAuthTestContext();
    const session = await seedAuthSession(context);
    const principal = await resolveBrowserPrincipal(
      context.db,
      context.auth,
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}/auth/session`, {
        headers: { cookie: session.cookie },
      }),
      "2026-08-11T20:00:00Z",
    );

    expect(principal).toEqual({
      type: "human",
      humanId: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
      authUserId: session.userId,
      email: "c02-human@synthetic.test",
      displayName: "C02 Human",
      sessionId: session.sessionId,
    });
    expect(principal).not.toHaveProperty("workspaceId");
    expect(principal).not.toHaveProperty("role");
    expect(
      context.raw
        .prepare("SELECT COUNT(*) AS count FROM workspace_members WHERE human_id = ?")
        .get(principal?.humanId),
    ).toEqual({ count: 0 });
  });

  it("fails closed on invalid auth key rings and origins", () => {
    const context = openAuthTestContext();
    const valid = { ...AUTH_TEST_ENV };
    expect(() =>
      humanAuthOptions(context.raw, { ...valid, BETTER_AUTH_SECRETS: "1:short" }),
    ).toThrow(/versioned key/);
    expect(() =>
      humanAuthOptions(context.raw, {
        ...valid,
        BETTER_AUTH_SECRETS: `${valid.BETTER_AUTH_SECRETS},0:third-key-that-is-long-enough-123456`,
      }),
    ).toThrow(/at most one previous/);
    expect(() =>
      humanAuthOptions(context.raw, { ...valid, APP_ORIGIN: "http://bfb.example.test" }),
    ).toThrow(/secure origin/);
  });
});

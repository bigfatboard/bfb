// ABOUTME: Pins Better Auth configuration and detects drift from the reviewed D1 schema.
// ABOUTME: Disabled identity mutations and GitHub-only provider defaults remain explicit.

import { getMigrations } from "better-auth/db/migration";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { humanAuthOptions } from "../src/auth/better-auth.js";
import { AUTH_TEST_ENV, openAuthTestContext } from "./auth-helpers.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Better Auth configuration", () => {
  it("pins Better Auth 1.6.26 as a runtime dependency", () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.["better-auth"]).toBe("1.6.26");
    expect(manifest.devDependencies?.["better-auth"]).toBeUndefined();
  });

  it("matches the checked-in migration with no generated schema drift", async () => {
    const context = openAuthTestContext();
    const migrations = await getMigrations(humanAuthOptions(context.raw, AUTH_TEST_ENV));
    expect(migrations.toBeCreated).toEqual([]);
    expect(migrations.toBeAdded).toEqual([]);
    expect(await migrations.compileMigrations()).toBe(";");
  });

  it("keeps GitHub as the only provider and disables implicit account mutations", () => {
    const context = openAuthTestContext();
    const options = humanAuthOptions(context.raw, AUTH_TEST_ENV);
    expect(Object.keys(options.socialProviders ?? {})).toEqual(["github"]);
    expect(options.emailAndPassword?.enabled).toBe(false);
    expect(options.account?.encryptOAuthTokens).toBe(true);
    expect(options.account?.storeStateStrategy).toBe("database");
    expect(options.account?.storeAccountCookie).toBe(false);
    expect(options.account?.accountLinking).toMatchObject({
      enabled: false,
      disableImplicitLinking: true,
      allowDifferentEmails: false,
      allowUnlinkingAll: false,
    });
    expect(options.user?.deleteUser?.enabled).toBe(false);
    expect(options.user?.changeEmail?.enabled).toBe(false);
    expect(options.telemetry?.enabled).toBe(false);
    expect(options.disabledPaths).toEqual(
      expect.arrayContaining([
        "/delete-user",
        "/link-social",
        "/sign-in/email",
        "/sign-up/email",
        "/update-user",
      ]),
    );
  });
});

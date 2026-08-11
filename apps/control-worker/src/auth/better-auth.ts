// ABOUTME: Configures Better Auth for GitHub-only human sign-in on the control Worker.
// ABOUTME: Versioned secrets, D1 protocol tables, and disabled account mutations fail closed.

import { betterAuth, type BetterAuthOptions } from "better-auth";
import { passkey, type PasskeyOptions } from "@better-auth/passkey";

export interface AuthEnv {
  APP_ORIGIN: string;
  BETTER_AUTH_SECRETS: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  AUTH_ABUSE_SECRET: string;
}

export interface AuthKey {
  version: number;
  value: string;
}

export type AuthDatabase = NonNullable<BetterAuthOptions["database"]>;

const MIN_SECRET_LENGTH = 32;
const MAX_SECRET_VERSIONS = 2;

const DISABLED_AUTH_PATHS = [
  "/account-info",
  "/change-email",
  "/change-password",
  "/delete-user",
  "/delete-user/callback",
  "/get-access-token",
  "/link-social",
  "/list-accounts",
  "/list-sessions",
  "/passkey/delete-passkey",
  "/passkey/generate-authenticate-options",
  "/passkey/generate-register-options",
  "/passkey/list-user-passkeys",
  "/passkey/update-passkey",
  "/passkey/verify-authentication",
  "/passkey/verify-registration",
  "/refresh-token",
  "/request-password-reset",
  "/reset-password",
  "/revoke-other-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/send-verification-email",
  "/set-password",
  "/sign-in/email",
  "/sign-up/email",
  "/unlink-account",
  "/update-session",
  "/update-user",
  "/verify-email",
] as const;

export function parseAuthKeys(value: string): AuthKey[] {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length < 1 || entries.length > MAX_SECRET_VERSIONS) {
    throw new Error("BETTER_AUTH_SECRETS must contain a current key and at most one previous key");
  }
  const versions = new Set<number>();
  return entries.map((entry) => {
    const separator = entry.indexOf(":");
    const versionText = separator === -1 ? "" : entry.slice(0, separator);
    const secret = separator === -1 ? "" : entry.slice(separator + 1);
    const version = Number(versionText);
    if (
      !/^(0|[1-9][0-9]*)$/.test(versionText) ||
      !Number.isSafeInteger(version) ||
      versions.has(version) ||
      secret.length < MIN_SECRET_LENGTH
    ) {
      throw new Error("BETTER_AUTH_SECRETS contains an invalid versioned key");
    }
    versions.add(version);
    return { version, value: secret };
  });
}

function validateAuthEnv(env: AuthEnv): { origin: string; keys: AuthKey[] } {
  let origin: URL;
  try {
    origin = new URL(env.APP_ORIGIN);
  } catch {
    throw new Error("APP_ORIGIN is invalid for human auth");
  }
  if (
    (origin.protocol !== "https:" &&
      origin.hostname !== "localhost" &&
      !origin.hostname.endsWith(".localhost")) ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new Error("APP_ORIGIN must be an exact secure origin for human auth");
  }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new Error("GitHub OAuth credentials are required for human auth");
  }
  if (!env.AUTH_ABUSE_SECRET || env.AUTH_ABUSE_SECRET.length < MIN_SECRET_LENGTH) {
    throw new Error("AUTH_ABUSE_SECRET missing or too short");
  }
  return { origin: origin.origin, keys: parseAuthKeys(env.BETTER_AUTH_SECRETS) };
}

export function humanPasskeyOptions(appOrigin: string): PasskeyOptions {
  const origin = new URL(appOrigin);
  return {
    rpID: origin.hostname,
    rpName: "BFB",
    origin: origin.origin,
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
    },
    advanced: {
      webAuthnChallengeCookie: "__Host-bfb_passkey_challenge",
    },
    schema: {
      passkey: {
        modelName: "better_auth_passkeys",
        fields: {
          name: "name",
          publicKey: "public_key",
          userId: "user_id",
          credentialID: "credential_id",
          counter: "counter",
          deviceType: "device_type",
          backedUp: "backed_up",
          transports: "transports",
          createdAt: "created_at",
          aaguid: "aaguid",
        },
      },
    },
  };
}

export function humanAuthOptions(database: AuthDatabase, env: AuthEnv): BetterAuthOptions {
  const { origin, keys } = validateAuthEnv(env);
  return {
    appName: "BFB",
    baseURL: origin,
    basePath: "/auth",
    database,
    secrets: keys,
    trustedOrigins: [origin],
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      },
    },
    emailAndPassword: { enabled: false },
    user: {
      modelName: "better_auth_users",
      fields: {
        emailVerified: "email_verified",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
    },
    session: {
      modelName: "better_auth_sessions",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        userId: "user_id",
      },
      cookieCache: { enabled: false },
    },
    account: {
      modelName: "better_auth_accounts",
      fields: {
        accountId: "account_id",
        providerId: "provider_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      encryptOAuthTokens: true,
      storeStateStrategy: "database",
      storeAccountCookie: false,
      accountLinking: {
        enabled: false,
        disableImplicitLinking: true,
        allowDifferentEmails: false,
        allowUnlinkingAll: false,
      },
    },
    verification: {
      modelName: "better_auth_verifications",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      storeIdentifier: "hashed",
    },
    rateLimit: { enabled: false },
    disabledPaths: [...DISABLED_AUTH_PATHS],
    plugins: [passkey(humanPasskeyOptions(origin))],
    telemetry: { enabled: false },
    logger: { disabled: true },
    advanced: {
      disableCSRFCheck: false,
      disableOriginCheck: false,
      trustedProxyHeaders: false,
      useSecureCookies: false,
      cookiePrefix: "__Host-bfb",
      defaultCookieAttributes: {
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "lax",
      },
      cookies: {
        session_token: {
          name: "__Host-bfb_session",
          attributes: {
            path: "/",
            httpOnly: true,
            secure: true,
            sameSite: "lax",
          },
        },
      },
    },
  };
}

export function createHumanAuth(database: AuthDatabase, env: AuthEnv) {
  return betterAuth(humanAuthOptions(database, env));
}

export type HumanAuth = ReturnType<typeof createHumanAuth>;

// ABOUTME: Configures Better Auth for human GitHub sign-in and session cookies on the control Worker.
// ABOUTME: BFB workspace authorization remains outside Better Auth and is checked per request.

import { betterAuth } from "better-auth";

export interface AuthEnv {
  APP_ORIGIN: string;
  BETTER_AUTH_SECRET: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

const MIN_SECRET_LENGTH = 32;

/**
 * Creates the Better Auth instance for browser sessions.
 * GitHub is enabled when credentials are present; otherwise email/password fixtures serve tests.
 * Secrets fail closed when missing or short. Cookie session caching stays disabled.
 */
export function createHumanAuth(env: AuthEnv) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < MIN_SECRET_LENGTH) {
    throw new Error("BETTER_AUTH_SECRET missing or too short (fail-closed)");
  }

  const socialProviders =
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? {
          github: {
            clientId: env.GITHUB_CLIENT_ID,
            clientSecret: env.GITHUB_CLIENT_SECRET,
          },
        }
      : undefined;

  return betterAuth({
    baseURL: env.APP_ORIGIN,
    secret: env.BETTER_AUTH_SECRET,
    emailAndPassword: {
      enabled: true,
    },
    socialProviders,
    session: {
      cookieCache: {
        enabled: false,
      },
    },
    // Better Auth owns protocol tables; C02 mounts routes only. Schema migrations stay in F04 chain.
    advanced: {
      disableOriginCheck: false,
      useSecureCookies: true,
    },
  });
}

export type HumanAuth = ReturnType<typeof createHumanAuth>;

// ABOUTME: Enrolls a synthetic user-verifying passkey in Chromium for product-surface E2E tests.
// ABOUTME: The returned cleanup removes the isolated virtual authenticator after each proof flow.

import type { Page } from "@playwright/test";

export async function enrollVirtualPasskey(page: Page): Promise<() => Promise<void>> {
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable");
  const authenticator = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  try {
    await page.evaluate(async () => {
      const encode = (value: ArrayBuffer | null): string => {
        if (!value) return "";
        let binary = "";
        for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
        return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
      };
      const decode = (value: string): ArrayBuffer => {
        const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
        const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
        return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)).buffer;
      };
      const sessionResponse = await fetch("/auth/session");
      const { csrf_token: csrfToken } = (await sessionResponse.json()) as {
        csrf_token: string;
      };
      const flowResponse = await fetch("/__test/passkey-flow", { method: "POST" });
      const { flow_id: flowId } = (await flowResponse.json()) as { flow_id: string };
      const headers = { "content-type": "application/json", "x-bfb-csrf": csrfToken };
      const optionsResponse = await fetch("/auth/passkeys/enroll/options", {
        method: "POST",
        headers,
        body: JSON.stringify({ flow_id: flowId, name: "W01 policy proof" }),
      });
      if (!optionsResponse.ok) {
        throw new Error(`registration options failed: ${optionsResponse.status}`);
      }
      const payload = (await optionsResponse.json()) as {
        options: PublicKeyCredentialCreationOptionsJSON;
      };
      const publicKey = {
        ...payload.options,
        challenge: decode(payload.options.challenge),
        user: { ...payload.options.user, id: decode(payload.options.user.id) },
        excludeCredentials: payload.options.excludeCredentials?.map((credential) => ({
          ...credential,
          id: decode(credential.id),
        })),
      } as PublicKeyCredentialCreationOptions;
      const credential = (await navigator.credentials.create({
        publicKey,
      })) as PublicKeyCredential;
      const response = credential.response as AuthenticatorAttestationResponse;
      const verification = await fetch("/auth/passkeys/enroll/verify", {
        method: "POST",
        headers,
        body: JSON.stringify({
          flow_id: flowId,
          response: {
            id: credential.id,
            rawId: encode(credential.rawId),
            type: credential.type,
            authenticatorAttachment: credential.authenticatorAttachment,
            clientExtensionResults: credential.getClientExtensionResults(),
            response: {
              clientDataJSON: encode(response.clientDataJSON),
              attestationObject: encode(response.attestationObject),
              transports: response.getTransports?.() ?? [],
            },
          },
        }),
      });
      if (!verification.ok) {
        throw new Error(`registration verification failed: ${verification.status}`);
      }
    });
  } catch (error) {
    await client.send("WebAuthn.removeVirtualAuthenticator", {
      authenticatorId: authenticator.authenticatorId,
    });
    await client.send("WebAuthn.disable");
    throw error;
  }
  return async () => {
    await client.send("WebAuthn.removeVirtualAuthenticator", {
      authenticatorId: authenticator.authenticatorId,
    });
    await client.send("WebAuthn.disable");
  };
}

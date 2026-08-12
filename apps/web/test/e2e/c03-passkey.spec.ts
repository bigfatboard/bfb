// ABOUTME: Drives C03 registration, step-up, additional enrollment, replay, and removal in Chromium.
// ABOUTME: A virtual user-verifying authenticator exercises real WebAuthn signatures and counters.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { FIX } from "@bfb/domain";

import { signInAs } from "./helpers.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const evidenceDir =
  process.env.BFB_CAPTURE_EVIDENCE === "1"
    ? path.join(rootDir, "docs/work-packages/evidence/WP-C03/browser")
    : path.join(rootDir, "apps/web/test/e2e/test-results/c03");

interface ActionInput {
  action: string;
  clientId?: string;
  resource?: string;
  workspaceId?: string;
  projectId?: string;
  targetId?: string;
  scopes: string[];
  authorizationEpoch: number;
}

async function csrf(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch("/auth/session");
    if (!response.ok) {
      throw new Error(`session failed: ${response.status}`);
    }
    return ((await response.json()) as { csrf_token: string }).csrf_token;
  });
}

async function registerPasskey(
  page: Page,
  flowId: string,
  csrfToken: string,
  name: string,
): Promise<{ id: string; name: string | null }> {
  return page.evaluate(
    async ({ flowId: browserFlowId, csrfToken: browserCsrf, name: browserName }) => {
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
      const headers = {
        "content-type": "application/json",
        "x-bfb-csrf": browserCsrf,
      };
      const optionsResponse = await fetch("/auth/passkeys/enroll/options", {
        method: "POST",
        headers,
        body: JSON.stringify({ flow_id: browserFlowId, name: browserName }),
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
      const credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential;
      const response = credential.response as AuthenticatorAttestationResponse;
      const verification = await fetch("/auth/passkeys/enroll/verify", {
        method: "POST",
        headers,
        body: JSON.stringify({
          flow_id: browserFlowId,
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
      return ((await verification.json()) as { passkey: { id: string; name: string | null } })
        .passkey;
    },
    { flowId, csrfToken, name },
  );
}

async function stepUp(page: Page, csrfToken: string, action: ActionInput) {
  return page.evaluate(
    async ({ csrfToken: browserCsrf, action: browserAction }) => {
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
      const headers = {
        "content-type": "application/json",
        "x-bfb-csrf": browserCsrf,
      };
      const optionsResponse = await fetch("/auth/step-up/options", {
        method: "POST",
        headers,
        body: JSON.stringify({ action: browserAction }),
      });
      if (!optionsResponse.ok) {
        throw new Error(`step-up options failed: ${optionsResponse.status}`);
      }
      const payload = (await optionsResponse.json()) as {
        challenge_id: string;
        action: ActionInput & { expiresAt: string };
        options: PublicKeyCredentialRequestOptionsJSON;
      };
      const publicKey = {
        ...payload.options,
        challenge: decode(payload.options.challenge),
        allowCredentials: payload.options.allowCredentials?.map((credential) => ({
          ...credential,
          id: decode(credential.id),
        })),
      } as PublicKeyCredentialRequestOptions;
      const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential;
      const response = credential.response as AuthenticatorAssertionResponse;
      const assertion = {
        id: credential.id,
        rawId: encode(credential.rawId),
        type: credential.type,
        authenticatorAttachment: credential.authenticatorAttachment,
        clientExtensionResults: credential.getClientExtensionResults(),
        response: {
          clientDataJSON: encode(response.clientDataJSON),
          authenticatorData: encode(response.authenticatorData),
          signature: encode(response.signature),
          userHandle: encode(response.userHandle),
        },
      };
      const verification = await fetch("/auth/step-up/verify", {
        method: "POST",
        headers,
        body: JSON.stringify({ challenge_id: payload.challenge_id, response: assertion }),
      });
      const result = (await verification.json()) as {
        proof_id?: string;
        action?: ActionInput & { expiresAt: string };
      };
      return {
        status: verification.status,
        proofId: result.proof_id,
        action: result.action,
        challengeId: payload.challenge_id,
        assertion,
      };
    },
    { csrfToken, action },
  );
}

test("user-verifying passkeys gate enrollment, step-up, replay, and removal", async ({ page }) => {
  await mkdir(evidenceDir, { recursive: true });
  await signInAs(page, "owner");
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable");
  let authenticator = await client.send("WebAuthn.addVirtualAuthenticator", {
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
    const csrfToken = await csrf(page);
    const fixtureFlow = await page.evaluate(async () => {
      const response = await fetch("/__test/passkey-flow", { method: "POST" });
      if (!response.ok) throw new Error(`fixture flow failed: ${response.status}`);
      return (await response.json()) as { flow_id: string };
    });
    const primary = await registerPasskey(page, fixtureFlow.flow_id, csrfToken, "Primary");
    expect(primary.name).toBe("Primary");

    const wrongAction = await stepUp(page, csrfToken, {
      action: "oauth.delegation.create",
      clientId: FIX.client,
      resource: `${new URL(page.url()).origin}/mcp`,
      workspaceId: FIX.workspace,
      projectId: FIX.projectA,
      scopes: ["bfb:read"],
      authorizationEpoch: 1,
    });
    expect(wrongAction.status).toBe(200);
    const wrongUse = await page.evaluate(
      async ({ csrfToken: browserCsrf, proofId, proofAction }) => {
        return (
          await fetch("/auth/passkeys/enroll/start", {
            method: "POST",
            headers: { "content-type": "application/json", "x-bfb-csrf": browserCsrf },
            body: JSON.stringify({ proof_id: proofId, proof_action: proofAction }),
          })
        ).status;
      },
      { csrfToken, proofId: wrongAction.proofId, proofAction: wrongAction.action },
    );
    expect(wrongUse).toBe(403);

    const addAuthorization = await stepUp(page, csrfToken, {
      action: "passkey.enroll.additional",
      scopes: [],
      authorizationEpoch: 0,
    });
    expect(addAuthorization.status).toBe(200);
    const additionalFlow = await page.evaluate(
      async ({ csrfToken: browserCsrf, proofId, proofAction }) => {
        const response = await fetch("/auth/passkeys/enroll/start", {
          method: "POST",
          headers: { "content-type": "application/json", "x-bfb-csrf": browserCsrf },
          body: JSON.stringify({ proof_id: proofId, proof_action: proofAction }),
        });
        return {
          status: response.status,
          body: (await response.json()) as { flow_id?: string },
        };
      },
      { csrfToken, proofId: addAuthorization.proofId, proofAction: addAuthorization.action },
    );
    expect(additionalFlow.status).toBe(200);
    expect(additionalFlow.body.flow_id).toBeTruthy();
    const proofReplay = await page.evaluate(
      async ({ csrfToken: browserCsrf, proofId, proofAction }) =>
        (
          await fetch("/auth/passkeys/enroll/start", {
            method: "POST",
            headers: { "content-type": "application/json", "x-bfb-csrf": browserCsrf },
            body: JSON.stringify({ proof_id: proofId, proof_action: proofAction }),
          })
        ).status,
      { csrfToken, proofId: addAuthorization.proofId, proofAction: addAuthorization.action },
    );
    expect(proofReplay).toBe(403);
    await client.send("WebAuthn.removeVirtualAuthenticator", {
      authenticatorId: authenticator.authenticatorId,
    });
    authenticator = await client.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "usb",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    const second = await registerPasskey(page, additionalFlow.body.flow_id!, csrfToken, "Backup");

    const removeAuthorization = await stepUp(page, csrfToken, {
      action: "passkey.remove",
      targetId: second.id,
      scopes: [],
      authorizationEpoch: 0,
    });
    expect(removeAuthorization.status).toBe(200);
    const removal = await page.evaluate(
      async ({ csrfToken: browserCsrf, passkeyId, proofId, proofAction }) =>
        (
          await fetch("/auth/passkeys/remove", {
            method: "POST",
            headers: { "content-type": "application/json", "x-bfb-csrf": browserCsrf },
            body: JSON.stringify({
              passkey_id: passkeyId,
              proof_id: proofId,
              proof_action: proofAction,
            }),
          })
        ).status,
      {
        csrfToken,
        passkeyId: second.id,
        proofId: removeAuthorization.proofId,
        proofAction: removeAuthorization.action,
      },
    );
    expect(removal).toBe(200);

    const passkeys = await page.evaluate(async () => {
      const response = await fetch("/auth/passkeys");
      return (await response.json()) as { passkeys: Array<{ id: string }> };
    });
    expect(passkeys.passkeys.map((passkey) => passkey.id)).toEqual([primary.id]);

    await page.evaluate(
      ({ primaryId, removedId }) => {
        document.body.innerHTML = "";
        const main = document.createElement("main");
        const heading = document.createElement("h1");
        heading.textContent = "BFB passkey security flow";
        const report = document.createElement("pre");
        report.textContent = [
          "user verification: required",
          `primary enrolled: ${primaryId}`,
          "wrong action rejected: yes",
          "proof replay rejected: yes",
          `additional passkey removed: ${removedId}`,
          "remaining passkeys: 1",
        ].join("\n");
        main.append(heading, report);
        document.body.append(main);
      },
      { primaryId: primary.id, removedId: second.id },
    );
    await page.screenshot({ path: path.join(evidenceDir, "passkey-flow.png"), fullPage: true });
    await writeFile(
      path.join(evidenceDir, "passkey-flow.md"),
      [
        "# C03 browser WebAuthn trace",
        "",
        "- Chromium used a CTAP2 platform authenticator with resident keys and user verification enabled.",
        "- A BFB-owned initial-enrollment flow registered the primary credential.",
        "- A proof for `oauth.delegation.create` could not authorize additional enrollment.",
        "- A user-verified `passkey.enroll.additional` proof authorized one additional credential and failed on replay.",
        "- A target-bound `passkey.remove` proof removed only the selected additional credential.",
        "- One primary credential remained.",
        "",
      ].join("\n"),
      "utf8",
    );
  } finally {
    await client.send("WebAuthn.removeVirtualAuthenticator", {
      authenticatorId: authenticator.authenticatorId,
    });
    await client.send("WebAuthn.disable");
  }
});

// ABOUTME: Converts BFB WebAuthn JSON options into browser credentials for action-bound step-up.
// ABOUTME: Returns only the one-time proof ID needed by the sensitive API mutation.

export interface StepUpActionRequest {
  action: string;
  workspaceId: string;
  targetId: string;
  scopes: string[];
  authorizationEpoch: number;
}

interface CredentialDescriptorJSON {
  id: string;
  type: PublicKeyCredentialType;
  transports?: AuthenticatorTransport[];
}

interface RequestOptionsJSON {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: CredentialDescriptorJSON[];
  userVerification?: UserVerificationRequirement;
}

function decodeBase64Url(value: string): ArrayBuffer {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)).buffer;
}

function encodeBase64Url(value: ArrayBuffer | null): string {
  if (!value) {
    return "";
  }
  let binary = "";
  for (const byte of new Uint8Array(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? fallback;
  } catch {
    return fallback;
  }
}

export async function requestStepUpProof(
  fetchImpl: typeof fetch,
  csrfToken: string,
  action: StepUpActionRequest,
): Promise<string> {
  if (!globalThis.PublicKeyCredential || !navigator.credentials) {
    throw new Error("This browser cannot perform the required passkey check.");
  }
  const headers = { "content-type": "application/json", "x-bfb-csrf": csrfToken };
  const optionsResponse = await fetchImpl("/auth/step-up/options", {
    method: "POST",
    headers,
    body: JSON.stringify({ action }),
  });
  if (!optionsResponse.ok) {
    throw new Error(await errorMessage(optionsResponse, "A registered passkey is required."));
  }
  const payload = (await optionsResponse.json()) as {
    challenge_id: string;
    options: RequestOptionsJSON;
  };
  const publicKey = {
    ...payload.options,
    challenge: decodeBase64Url(payload.options.challenge),
    allowCredentials: payload.options.allowCredentials?.map((credential) => ({
      ...credential,
      id: decodeBase64Url(credential.id),
    })),
  } as PublicKeyCredentialRequestOptions;
  const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!credential) {
    throw new Error("Passkey verification was cancelled.");
  }
  const assertion = credential.response as AuthenticatorAssertionResponse;
  const verification = await fetchImpl("/auth/step-up/verify", {
    method: "POST",
    headers,
    body: JSON.stringify({
      challenge_id: payload.challenge_id,
      response: {
        id: credential.id,
        rawId: encodeBase64Url(credential.rawId),
        type: credential.type,
        authenticatorAttachment: credential.authenticatorAttachment,
        clientExtensionResults: credential.getClientExtensionResults(),
        response: {
          clientDataJSON: encodeBase64Url(assertion.clientDataJSON),
          authenticatorData: encodeBase64Url(assertion.authenticatorData),
          signature: encodeBase64Url(assertion.signature),
          userHandle: encodeBase64Url(assertion.userHandle),
        },
      },
    }),
  });
  if (!verification.ok) {
    throw new Error(await errorMessage(verification, "Passkey verification failed."));
  }
  const result = (await verification.json()) as { proof_id?: string };
  if (!result.proof_id) {
    throw new Error("Passkey verification returned no proof.");
  }
  return result.proof_id;
}

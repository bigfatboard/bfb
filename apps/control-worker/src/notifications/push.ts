// ABOUTME: Encrypts and sends Web Push messages with VAPID auth and aes128gcm per RFC 8291/8292.
// ABOUTME: Secrets arrive only from Worker env; this module never logs keys, endpoints, or bodies.

export const PUSH_TTL_SECONDS = 86_400;
export const PUSH_RECORD_SIZE = 4096;

export interface VapidSecrets {
  publicKey: string;
  privateKey: string;
  subject: string;
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = padded.length % 4;
  const full = remainder === 0 ? padded : padded + "=".repeat(4 - remainder);
  const binary = atob(full);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, data));
}

function splitUncompressedPoint(point: Uint8Array): { x: Uint8Array; y: Uint8Array } {
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error("receiver key is not an uncompressed P-256 point");
  }
  return { x: point.slice(1, 33), y: point.slice(33, 65) };
}

/**
 * RFC 8291 §3 key derivation with caller-supplied salt and sender key, so
 * the RFC Appendix A vectors reproduce byte-for-byte. Production callers
 * pass a random salt and a fresh ephemeral keypair.
 */
export async function derivePushKeys(input: {
  receiverPublic: Uint8Array;
  authSecret: Uint8Array;
  salt: Uint8Array;
  senderPublic: Uint8Array;
  sharedSecret: Uint8Array;
}): Promise<{ cek: Uint8Array; nonce: Uint8Array }> {
  const keyInfo = concat(
    textBytes("WebPush: info"),
    new Uint8Array([0x00]),
    input.receiverPublic,
    input.senderPublic,
  );
  const prkKey = await hmacSha256(input.authSecret, input.sharedSecret);
  const ikm = await hmacSha256(prkKey, concat(keyInfo, new Uint8Array([0x01])));
  const prk = await hmacSha256(input.salt, ikm);
  const cekFull = await hmacSha256(
    prk,
    concat(textBytes("Content-Encoding: aes128gcm"), new Uint8Array([0x00, 0x01])),
  );
  const nonceFull = await hmacSha256(
    prk,
    concat(textBytes("Content-Encoding: nonce"), new Uint8Array([0x00, 0x01])),
  );
  return { cek: cekFull.slice(0, 16), nonce: nonceFull.slice(0, 12) };
}

export async function sharedSecret(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
): Promise<Uint8Array> {
  // workers-types names the field `$public`, but the WebCrypto runtime (workerd
  // and Node) reads the standard `public` member; the cast keeps both honest.
  const algorithm = { name: "ECDH", public: publicKey } as unknown as Parameters<
    typeof crypto.subtle.deriveBits
  >[0];
  const bits = await crypto.subtle.deriveBits(algorithm, privateKey, 256);
  return new Uint8Array(bits);
}

export async function importReceiverPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  splitUncompressedPoint(raw);
  return crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, false, []);
}

export async function importKeyPair(input: {
  privateScalar: Uint8Array;
  publicPoint: Uint8Array;
}): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
  if (input.privateScalar.length !== 32) {
    throw new Error("private scalar must be 32 octets");
  }
  const { x, y } = splitUncompressedPoint(input.publicPoint);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: base64UrlEncode(input.privateScalar),
    x: base64UrlEncode(x),
    y: base64UrlEncode(y),
  };
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  return { privateKey, publicKey };
}

/** RFC 8291 §4 single-record body: salt || rs || keyidlen || as_pub || ciphertext. */
export async function encryptPushBody(input: {
  receiverPublic: Uint8Array;
  authSecret: Uint8Array;
  plaintext: Uint8Array;
  salt?: Uint8Array | undefined;
  senderKeys?: { privateKey: CryptoKey; publicPoint: Uint8Array } | undefined;
}): Promise<Uint8Array> {
  if (input.receiverPublic.length !== 65 || input.authSecret.length !== 16) {
    throw new Error("receiver keys are invalid");
  }
  if (input.plaintext.length > 3993) {
    throw new Error("push plaintext exceeds the single-record bound");
  }
  const salt = input.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) {
    throw new Error("push salt must be 16 octets");
  }
  let senderPublic: Uint8Array;
  let secret: Uint8Array;
  if (input.senderKeys) {
    senderPublic = input.senderKeys.publicPoint;
    const receiver = await importReceiverPublicKey(input.receiverPublic);
    secret = await sharedSecret(input.senderKeys.privateKey, receiver);
  } else {
    const pair = (await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    )) as CryptoKeyPair;
    const raw = new Uint8Array(
      (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
    );
    senderPublic = raw;
    const receiver = await importReceiverPublicKey(input.receiverPublic);
    secret = await sharedSecret(pair.privateKey, receiver);
  }
  const { cek, nonce } = await derivePushKeys({
    receiverPublic: input.receiverPublic,
    authSecret: input.authSecret,
    salt,
    senderPublic,
    sharedSecret: secret,
  });
  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const padded = concat(input.plaintext, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, padded));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, PUSH_RECORD_SIZE, false);
  return concat(salt, rs, new Uint8Array([senderPublic.length]), senderPublic, ciphertext);
}

function parseVapidSecrets(vapid: VapidSecrets): { publicPoint: Uint8Array; privateScalar: Uint8Array } {
  let publicPoint: Uint8Array;
  let privateScalar: Uint8Array;
  try {
    publicPoint = base64UrlDecode(vapid.publicKey);
    privateScalar = base64UrlDecode(vapid.privateKey);
  } catch {
    throw new Error("vapid keys are invalid");
  }
  splitUncompressedPoint(publicPoint);
  if (privateScalar.length !== 32) {
    throw new Error("vapid keys are invalid");
  }
  if (typeof vapid.subject !== "string" || vapid.subject.length < 7 || vapid.subject.length > 128) {
    throw new Error("vapid subject is invalid");
  }
  return { publicPoint, privateScalar };
}

async function vapidAuthorization(input: {
  endpoint: string;
  publicPoint: Uint8Array;
  privateScalar: Uint8Array;
  subject: string;
  nowMs: number;
}): Promise<string> {
  const url = new URL(input.endpoint);
  const header = base64UrlEncode(textBytes(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64UrlEncode(
    textBytes(
      JSON.stringify({
        aud: `${url.protocol}//${url.host}`,
        exp: Math.floor(input.nowMs / 1000) + 43200,
        sub: input.subject,
      }),
    ),
  );
  const signingInput = textBytes(`${header}.${claims}`);
  const { x, y } = splitUncompressedPoint(input.publicPoint);
  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: base64UrlEncode(input.privateScalar),
      x: base64UrlEncode(x),
      y: base64UrlEncode(y),
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, signingInput),
  );
  return `vapid t=${header}.${claims}.${base64UrlEncode(signature)}, k=${base64UrlEncode(input.publicPoint)}`;
}

export interface PushOutcome {
  status: number;
}

/** Sends one encrypted push message. Returns the push service status; throws only on local failures. */
export async function sendPushMessage(
  input: {
    endpoint: string;
    p256dh: string;
    auth: string;
    plaintext: Uint8Array;
    vapid: VapidSecrets;
    ttlSeconds?: number | undefined;
    nowMs?: number | undefined;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<PushOutcome> {
  const secrets = parseVapidSecrets(input.vapid);
  let receiver: Uint8Array;
  let authSecret: Uint8Array;
  try {
    receiver = base64UrlDecode(input.p256dh);
    authSecret = base64UrlDecode(input.auth);
  } catch {
    throw new Error("receiver keys are invalid");
  }
  const body = await encryptPushBody({
    receiverPublic: receiver,
    authSecret,
    plaintext: input.plaintext,
  });
  const authorization = await vapidAuthorization({
    endpoint: input.endpoint,
    publicPoint: secrets.publicPoint,
    privateScalar: secrets.privateScalar,
    subject: input.vapid.subject,
    nowMs: input.nowMs ?? Date.now(),
  });
  const response = await fetchImpl(input.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "content-encoding": "aes128gcm",
      ttl: String(input.ttlSeconds ?? PUSH_TTL_SECONDS),
      authorization,
    },
    body: body as unknown as BodyInit,
  });
  return { status: response.status };
}

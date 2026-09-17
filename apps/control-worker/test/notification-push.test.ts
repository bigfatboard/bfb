// ABOUTME: Reproduces RFC 8291 Appendix A vectors byte-for-byte through the X01 push sender.
// ABOUTME: A separate round-trip proves the harness fake-push service can decrypt what we send.

import { describe, expect, it } from "vitest";

import {
  base64UrlEncode,
  derivePushKeys,
  encryptPushBody,
  importKeyPair,
  importReceiverPublicKey,
  sharedSecret,
} from "../src/notifications/push.js";

function b64(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const full = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  return Uint8Array.from(atob(full), (char) => char.charCodeAt(0));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// RFC 8291 §5 / Appendix A inputs (presentation whitespace removed).
const PLAINTEXT = b64("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24");
const AS_PUBLIC = b64(
  "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
);
const AS_PRIVATE = b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw");
const UA_PUBLIC = b64(
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
);
const UA_PRIVATE = b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94");
const SALT = b64("DGv6ra1nlYgDCS1FRnbzlw");
const AUTH = b64("BTBZMqHH6r4Tts7J_aSIgg");

describe("rfc8291 vectors", () => {
  it("derives the Appendix A intermediate keys", async () => {
    const sender = await importKeyPair({ privateScalar: AS_PRIVATE, publicPoint: AS_PUBLIC });
    const receiver = await importReceiverPublicKey(UA_PUBLIC);
    const secret = await sharedSecret(sender.privateKey, receiver);
    expect(base64UrlEncode(secret)).toBe("kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs");
    const { cek, nonce } = await derivePushKeys({
      receiverPublic: UA_PUBLIC,
      authSecret: AUTH,
      salt: SALT,
      senderPublic: AS_PUBLIC,
      sharedSecret: secret,
    });
    expect(base64UrlEncode(cek)).toBe("oIhVW04MRdy2XN9CiKLxTg");
    expect(base64UrlEncode(nonce)).toBe("4h_95klXJ5E_qnoN");
  });

  it("encrypts the Appendix A body byte-for-byte", async () => {
    const sender = await importKeyPair({ privateScalar: AS_PRIVATE, publicPoint: AS_PUBLIC });
    const body = await encryptPushBody({
      receiverPublic: UA_PUBLIC,
      authSecret: AUTH,
      plaintext: PLAINTEXT,
      salt: SALT,
      senderKeys: { privateKey: sender.privateKey, publicPoint: AS_PUBLIC },
    });
    // Decoded separately: the joined 193-char transcription is not valid
    // base64, but each Appendix A part decodes to its exact octet count.
    const header = b64(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
    );
    const ciphertext = b64(
      "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
    );
    expect(header.length).toBe(86);
    expect(ciphertext.length).toBe(58);
    expect(body.length).toBe(144);
    expect(hex(body)).toBe(hex(new Uint8Array([...header, ...ciphertext])));
  });

  it("round-trips a fresh message through receiver-side decryption", async () => {
    const plaintext = new TextEncoder().encode(JSON.stringify({ title: "BFB needs your attention" }));
    const receiverKeys = await importKeyPair({ privateScalar: UA_PRIVATE, publicPoint: UA_PUBLIC });
    void receiverKeys;
    const body = await encryptPushBody({
      receiverPublic: UA_PUBLIC,
      authSecret: AUTH,
      plaintext,
    });
    const salt = body.slice(0, 16);
    const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false);
    expect(rs).toBe(4096);
    const keyLen = body[20];
    const asPublic = body.slice(21, 21 + keyLen);
    const ciphertext = body.slice(21 + keyLen);
    expect(keyLen).toBe(65);
    // Receiver side: ECDH(ua_private, as_public) with the transmitted key.
    const ua = await importKeyPair({ privateScalar: UA_PRIVATE, publicPoint: UA_PUBLIC });
    const as = await importReceiverPublicKey(asPublic);
    const secret = await sharedSecret(ua.privateKey, as);
    const { cek, nonce } = await derivePushKeys({
      receiverPublic: UA_PUBLIC,
      authSecret: AUTH,
      salt,
      senderPublic: asPublic,
      sharedSecret: secret,
    });
    const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
    const padded = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext),
    );
    expect(padded[padded.length - 1]).toBe(0x02);
    expect(hex(padded.slice(0, -1))).toBe(hex(plaintext));
  });
});

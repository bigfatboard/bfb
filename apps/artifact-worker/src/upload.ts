// ABOUTME: Accepts bounded artifact bytes against a consumed one-time upload grant.
// ABOUTME: Validates size, digest, and MIME before the conditional content-addressed R2 write.

import { createHash, createHmac } from "node:crypto";

import type { SqlDatabase } from "@bfb/db";
import {
  ARTIFACT_REVIEW_MAX_BYTES,
  assertHumanUploadDelivery,
  artifactObjectKey,
  artifactSubject,
  assertRoleKind,
  consumeArtifactBudget,
  formatAllowsKind,
  isUlid,
  recordVerifiedUpload,
  redeemUploadGrant,
  roleMaxBytes,
  sniffArtifactKind,
} from "@bfb/domain";

export interface UploadDeps {
  db: SqlDatabase;
  artifacts: R2Bucket;
  now: string;
  abuseSecret: string;
}

const BEARER_PATTERN = /^Bearer ([A-Za-z0-9_-]{16,256})$/;

export function artifactAbuseSeeds(
  abuseSecret: string,
  request: Request,
): { ipSeed: string; subjectSeed: string } | null {
  return uploadSeeds(abuseSecret, request);
}

function uploadSeeds(
  abuseSecret: string,
  request: Request,
): { ipSeed: string; subjectSeed: string } | null {
  if (typeof abuseSecret !== "string" || abuseSecret.length < 32) return null;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  return {
    ipSeed: createHmac("sha256", abuseSecret)
      .update(`artifact-ip:${ip.slice(0, 64)}`)
      .digest("hex"),
    subjectSeed: createHmac("sha256", abuseSecret).update("artifact-subject").digest("hex"),
  };
}

async function readBoundedBody(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
      throw new UploadError(413, "body_too_large");
    }
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new UploadError(413, "body_too_large");
      }
      chunks.push(chunk.value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class UploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason?: string,
  ) {
    super(code);
  }
}

function digestHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function verifiedExistingObject(
  bucket: R2Bucket,
  key: string,
  size: number,
  contentHash: string,
): Promise<boolean> {
  const head = await bucket.head(key);
  if (!head || head.size !== size) return false;
  const checksum = head.checksums?.sha256;
  if (checksum !== undefined) {
    return checksum.byteLength === 32 && Buffer.from(checksum).toString("hex") === contentHash;
  }
  // Custom metadata is caller-set, not an integrity check. Older objects may
  // lack a stored SHA-256, so rehash their bounded body without trusting it.
  const object = await bucket.get(key);
  if (
    !object ||
    !("body" in object) ||
    !object.body ||
    object.size !== size ||
    !head.version ||
    object.version !== head.version
  )
    return false;
  const reader = object.body.getReader();
  const hash = createHash("sha256");
  let received = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > size) {
        await reader.cancel();
        return false;
      }
      hash.update(chunk.value);
    }
    return received === size && hash.digest("hex") === contentHash;
  } finally {
    reader.releaseLock();
  }
}

/** Handles PUT /upload/:grantId. Every failure leaves a recoverable non-viewable version. */
export async function handleUpload(
  request: Request,
  grantId: string,
  deps: UploadDeps,
): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  const rejected = () =>
    new Response(JSON.stringify({ error: "request_rejected", message: "request rejected" }), {
      status: 403,
      headers,
    });
  try {
    if (request.method !== "PUT") {
      return new Response(JSON.stringify({ error: "method_not_allowed" }), {
        status: 405,
        headers,
      });
    }
    if (!isUlid(grantId)) return rejected();
    const authorization = request.headers.get("authorization") ?? "";
    const bearer = BEARER_PATTERN.exec(authorization);
    if (!bearer?.[1]) return rejected();
    const secret = bearer[1];

    const seeds = uploadSeeds(deps.abuseSecret, request);
    if (!seeds) return rejected();
    const budgeted = await consumeArtifactBudget(deps.db, {
      ...seeds,
      surface: "artifact:upload-attempt",
      subject: artifactSubject(`upload:${grantId}`),
      activity: "attempt",
      now: deps.now,
    });
    if (!budgeted) return rejected();

    // One conditional batch rechecks expiry, version state, and the current
    // authorization epoch, consumes the grant, and inserts the audit row
    // before any byte is accepted as an effect.
    let redeemed;
    try {
      redeemed = await deps.db.withTransaction((tx) =>
        redeemUploadGrant(tx, { grantId, secret, now: deps.now }),
      );
    } catch {
      return rejected();
    }

    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBody(request, ARTIFACT_REVIEW_MAX_BYTES + 1);
    } catch (error) {
      if (error instanceof UploadError) {
        return new Response(JSON.stringify({ error: error.code }), {
          status: error.status,
          headers,
        });
      }
      throw error;
    }
    const contentRejected = (reason: string) =>
      new Response(JSON.stringify({ error: "upload_rejected", message: reason }), {
        status: 422,
        headers,
      });
    if (bytes.byteLength !== redeemed.declaredSize) return contentRejected("size_mismatch");
    if (bytes.byteLength > roleMaxBytes(redeemed.role)) return contentRejected("size_mismatch");
    const contentHash = digestHex(bytes);
    if (contentHash !== redeemed.expectedDigest) return contentRejected("digest_mismatch");
    const kind = sniffArtifactKind(bytes);
    if (!formatAllowsKind(redeemed.format, kind)) return contentRejected("mime_mismatch");
    try {
      assertRoleKind(redeemed.role, kind);
    } catch {
      return contentRejected("role_mismatch");
    }

    const r2Key = artifactObjectKey({
      workspaceId: redeemed.workspaceId,
      role: redeemed.role,
      runId: redeemed.runId,
      versionId: redeemed.versionId,
      contentHash,
    });
    // Conditional create: an existing object is verified, never overwritten.
    let deduplicated = false;
    try {
      let written: R2Object | null;
      try {
        written = await deps.artifacts.put(r2Key, bytes, {
          sha256: contentHash,
          onlyIf: { etagDoesNotMatch: "*" },
          customMetadata: { sha256: contentHash },
        });
      } catch {
        // A lost write response may still have stored the correct object.
        written = null;
      }
      if (written === null) {
        if (!(await verifiedExistingObject(deps.artifacts, r2Key, bytes.byteLength, contentHash))) {
          return new Response(JSON.stringify({ error: "upload_failed" }), {
            status: 500,
            headers,
          });
        }
        deduplicated = true;
      }
    } catch {
      return new Response(JSON.stringify({ error: "upload_failed" }), {
        status: 500,
        headers,
      });
    }

    let receipt;
    try {
      receipt = await deps.db.withTransaction((tx) =>
        recordVerifiedUpload(tx, {
          grantId: redeemed.grantId,
          consumeAttemptId: redeemed.consumeAttemptId,
          contentHash,
          size: bytes.byteLength,
          now: deps.now,
        }),
      );
    } catch {
      // Convergence is guarded inside the atomic receipt helper. An unrelated
      // existing receipt must not turn a failed source/commit check into success.
      return new Response(JSON.stringify({ error: "upload_conflict" }), { status: 409, headers });
    }
    if (redeemed.humanId !== null) await assertHumanUploadDelivery(deps.db, redeemed, receipt);
    return new Response(
      JSON.stringify({
        version_id: redeemed.versionId,
        artifact_id: redeemed.artifactId,
        content_hash: contentHash,
        size: bytes.byteLength,
        r2_key: r2Key,
        deduplicated: deduplicated || receipt.deduplicated,
      }),
      { status: 200, headers },
    );
  } catch {
    // Never echo the bearer secret, digests, or bytes in an error response.
    return rejected();
  }
}

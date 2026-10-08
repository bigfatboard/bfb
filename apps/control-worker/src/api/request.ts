// ABOUTME: Reads JSON request bodies with a hard byte bound before parsing.
// ABOUTME: Streaming cancellation prevents oversized browser payloads from being buffered.

import { DomainError } from "@bfb/domain";

export async function readBoundedJson(request: Request, maximumBytes: number): Promise<unknown> {
  const bytes = await readBoundedBytes(request, maximumBytes);
  try {
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return JSON.parse(source) as unknown;
  } catch {
    throw new DomainError("invalid_json", "request body is not valid JSON");
  }
}

/** Wire codecs and possession checks consume the original bounded bytes, not reserialized JSON. */
export async function readBoundedBytes(
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
      throw new DomainError("body_too_large", "request body exceeds limit");
    }
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new DomainError("body_too_large", "request body exceeds limit");
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

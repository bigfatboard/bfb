// ABOUTME: Public TypeScript entry for BFB wire types, codecs, and protocol fakes.
// ABOUTME: Generated types are re-exported; validation always uses canonical JSON Schemas.

export {
  PROTOCOL_HEAD,
  SCHEMA_HASH,
  SCHEMA_VERSION,
  WIRE_DOCUMENT_NAMES,
} from "./generated/types.js";
export type * from "./generated/types.js";
export { decodeWireDocument, encodeWireDocument } from "./codec.js";
export type { DecodeResult } from "./codec.js";
export { FakeControlPlane, FakeProtocolClient } from "./fake/control-plane.js";
export type { FakeAttentionFixture, FakeContextFixture } from "./fake/control-plane.js";

// ABOUTME: Creates canonical random security-audit positions and hashes their private transport handles.
// ABOUTME: Only domain-separated hashes enter persistence and the registered position-issuance command.

import { createHash, randomBytes } from "node:crypto";

export interface IssueSecurityAuditPositionInput {
  positionHash: string;
  afterHash: string | null;
  limit: number;
}

export type IssueSecurityAuditPosition = (input: IssueSecurityAuditPositionInput) => Promise<void>;

export function createSecurityAuditPosition(): string {
  return randomBytes(32).toString("base64url");
}

/** Re-encoding also rejects noncanonical unused bits in the final base64url character. */
export function isSecurityAuditPosition(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(value))
    return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
}

export function hashSecurityAuditPosition(handle: string): string {
  if (!isSecurityAuditPosition(handle)) throw new TypeError("invalid security audit position");
  return createHash("sha256")
    .update("bfb/security-audit-position/v1\0")
    .update(handle)
    .digest("hex");
}

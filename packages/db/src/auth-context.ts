// ABOUTME: Defines immutable authorization and bootstrap contexts for tenant repositories.
// ABOUTME: Unscoped tenant access is structurally unavailable without an auth context.

import { assertAuthorizationEpoch, assertUlid } from "./primitives.js";

export type Jurisdiction = "eu" | "us" | "global";

export interface AuthorizationContext {
  readonly kind: "authorized";
  readonly workspaceId: string;
  readonly principalId: string;
  readonly authorizationEpoch: number;
  readonly jurisdiction: Jurisdiction;
}

export interface BootstrapContext {
  readonly kind: "bootstrap";
  readonly jurisdiction: Jurisdiction;
}

export function createAuthorizationContext(input: {
  workspaceId: string;
  principalId: string;
  authorizationEpoch: number;
  jurisdiction: Jurisdiction;
}): AuthorizationContext {
  assertUlid(input.workspaceId, "workspaceId");
  assertUlid(input.principalId, "principalId");
  assertAuthorizationEpoch(input.authorizationEpoch);
  assertJurisdiction(input.jurisdiction);
  return Object.freeze({
    kind: "authorized",
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    authorizationEpoch: input.authorizationEpoch,
    jurisdiction: input.jurisdiction,
  });
}

export function createBootstrapContext(jurisdiction: Jurisdiction): BootstrapContext {
  assertJurisdiction(jurisdiction);
  return Object.freeze({ kind: "bootstrap", jurisdiction });
}

function assertJurisdiction(value: string): asserts value is Jurisdiction {
  if (value !== "eu" && value !== "us" && value !== "global") {
    throw new Error("invalid jurisdiction");
  }
}

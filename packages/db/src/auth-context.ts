// ABOUTME: Defines immutable authorization and bootstrap contexts for tenant repositories.
// ABOUTME: Unscoped tenant access is structurally unavailable without an auth context.

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
  if (!input.workspaceId || !input.principalId) {
    throw new Error("authorization context requires workspace and principal");
  }
  if (input.authorizationEpoch < 1) {
    throw new Error("authorization epoch must be >= 1");
  }
  return {
    kind: "authorized",
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    authorizationEpoch: input.authorizationEpoch,
    jurisdiction: input.jurisdiction,
  };
}

export function createBootstrapContext(jurisdiction: Jurisdiction): BootstrapContext {
  return { kind: "bootstrap", jurisdiction };
}

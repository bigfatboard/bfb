// ABOUTME: Checks public browser handoff parsing and exact C06 action-fingerprint parity.
// ABOUTME: Rejects hidden key material, duplicate fields, malformed points and altered routing data.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalRunnerKey, runnerEnrollmentTarget } from "@bfb/domain";
import { hashPublicValue, parseEnrollmentFragment } from "../src/runner-enrollment.js";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../protocol/fixtures/v1/valid/runner-enrollment-handoff.public.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  schema_version: 1;
  workspace_id: string;
  runner_id: string;
  device_label: string;
  public_key: { crv: string; kty: string; x: string; y: string };
};
const canonical = {
  device_label: fixture.device_label,
  public_key: fixture.public_key,
  runner_id: fixture.runner_id,
  schema_version: fixture.schema_version,
  workspace_id: fixture.workspace_id,
};
const fragment = (value: unknown) =>
  "#" +
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

describe("public runner enrollment handoff", () => {
  it("matches the C06 enrollment target without browser-side Node crypto", async () => {
    const { handoff, thumbprint } = await parseEnrollmentFragment(fragment(canonical));
    const projects = ["01K00000000000000000000009"];
    const browserTarget = await hashPublicValue([
      "runner.enroll",
      handoff.runner_id,
      handoff.device_label,
      thumbprint,
      projects,
    ]);
    const serverTarget = runnerEnrollmentTarget({
      runnerId: handoff.runner_id,
      deviceLabel: handoff.device_label,
      publicKey: await canonicalRunnerKey(handoff.public_key),
      projectIds: projects,
    });
    expect(browserTarget).toBe(serverTarget);
  });

  it("rejects noncanonical or privilege-bearing fragments before any approval", async () => {
    for (const hostile of [
      { ...canonical, command: "synthetic-command" },
      { ...canonical, public_key: { ...fixture.public_key, d: "synthetic-private-key" } },
      { ...canonical, runner_id: "../another-workspace" },
      { ...canonical, device_label: "/synthetic/private/path" },
      { ...canonical, public_key: { ...fixture.public_key, x: "A".repeat(43), y: "A".repeat(43) } },
      JSON.stringify(canonical).replace(
        '{"device_label":',
        '{"device_label":"hidden","device_label":',
      ),
      { ...canonical, schema_version: 2 },
      "[]",
      "null",
    ])
      await expect(parseEnrollmentFragment(fragment(hostile))).rejects.toThrow();
    await expect(parseEnrollmentFragment("#" + "A".repeat(2049))).rejects.toThrow();
  });
});
